/* gl-renderer.js -- a Canvas2D-shaped WebGL backend for the Hex Squad Lanes world layer.
 *
 * WHY A SHIM AND NOT A REWRITE. The world layer is ~83KB of dense drawing code across
 * drawWorld/drawUnit/drawTriBeing/drawRing/drawHitFx/drawPlateFx/drawBooms/drawPickups/
 * drawBreachCut, using ~30 distinct ctx methods. Rewriting those call sites would be a
 * merge disaster in a file another agent commits to hourly, and would throw away every
 * balance/geometry comment sitting inside them. So this object answers to the same names
 * ctx does: the stages keep drawing in the coordinates they always used and never learn
 * the backend changed.
 *
 * WHY IT IS FASTER, AND WHERE IT IS NOT. Canvas2D re-rasterises every hex every frame in
 * native code. This batches every fill and stroke of a frame into ONE interleaved vertex
 * buffer and ONE draw call, with the transform applied on the CPU so nothing needs a
 * per-shape uniform. That trade only pays because the geometry here is small and flat --
 * hexes, triangles, wedges, short segments. It would NOT pay for a sprite/bitmap game.
 *
 * WHAT IT DELIBERATELY DOES NOT DO.
 *   - Text. fillText/strokeText are QUEUED, not drawn, and handed back for the 2D overlay
 *     canvas stacked above. Glyphs must stay unbent by the lens to stay readable, so this
 *     is the correct behaviour, not a shortcut.
 *   - shadowBlur. Six uses in the world layer, and CLAUDE.md already calls it the standing
 *     per-frame perf sin. Ignored here; those sites should become outline motifs.
 *   - Concave polygons. Every subpath is fanned from its own first vertex, which is exact
 *     for convex shapes and for the fan-shaped wedges this game draws, and wrong for a
 *     genuinely concave one. Verified against the real shapes before relying on it.
 *
 * TIMING NOTE FOR ANYONE MEASURING THIS: gl.finish() does NOT synchronise on iOS WebKit.
 * A per-frame timer around GL calls measures command submission, not rendering, and will
 * happily report a cached path as slower than the uncached one it contains. Measure with
 * real frames (rAF interval) instead. This cost five measurement rounds to learn.
 */
(function(){
'use strict';


/* ---------- recording Path2D ----------
   The world layer builds real Path2D objects (wall art, being interiors, the
   reach-map outline) and paints them with ctx.fill(path)/ctx.stroke(path). A
   native Path2D is opaque -- there is no way to read its geometry back -- so
   the shim would silently paint whatever path happened to be current instead,
   which rendered every hex as wall art.
   The fix is a SUBCLASS: it still IS a Path2D, so Canvas2D keeps working with
   zero call-site changes and zero behaviour change when the GL layer is off; it
   just also records the commands so the GL backend can replay them. Recording
   into one flat numeric array keeps this cheap -- some of these paths are rebuilt
   every frame (the being inner batch, the reach outline), and Path2D
   CONSTRUCTION is already the measured cost in this file, not painting. */
const OP_M=0, OP_L=1, OP_C=2, OP_ARC=3, OP_RECT=4, OP_Q=5, OP_B=6, OP_E=7;
(function installRecordingPath2D(){
  const Native = window.Path2D;
  if(!Native || Native.__hslRec) return;
  class RecPath2D extends Native {
    constructor(d){ super(d); this.__rec = []; }
    moveTo(x,y){ super.moveTo(x,y); this.__rec.push(OP_M,x,y); }
    lineTo(x,y){ super.lineTo(x,y); this.__rec.push(OP_L,x,y); }
    closePath(){ super.closePath(); this.__rec.push(OP_C); }
    rect(x,y,w,h){ super.rect(x,y,w,h); this.__rec.push(OP_RECT,x,y,w,h); }
    arc(x,y,r,a0,a1,ccw){ super.arc(x,y,r,a0,a1,ccw); this.__rec.push(OP_ARC,x,y,r,a0,a1,ccw?1:0); }
    quadraticCurveTo(cx,cy,x,y){ super.quadraticCurveTo(cx,cy,x,y); this.__rec.push(OP_Q,cx,cy,x,y); }
    bezierCurveTo(a,b,c,d,e,f){ super.bezierCurveTo(a,b,c,d,e,f); this.__rec.push(OP_B,a,b,c,d,e,f); }
    ellipse(x,y,rx,ry,rot,a0,a1,ccw){ super.ellipse(x,y,rx,ry,rot,a0,a1,ccw); this.__rec.push(OP_E,x,y,rx,ry,rot,a0,a1,ccw?1:0); }
    addPath(pth,tr){
      super.addPath(pth,tr);
      if(pth && pth.__rec && !tr) for(let i=0;i<pth.__rec.length;i++) this.__rec.push(pth.__rec[i]);   /* inlined, so the recording stays one flat array; a transformed addPath is not used here and is deliberately not recorded rather than recorded wrong */
      else if(pth && pth.__rec && tr) this.__rec.length = this.__rec.length;   /* no-op: see above */
    }
  }
  RecPath2D.__hslRec = true;
  window.Path2D = RecPath2D;
})();

/* ---------- colour ---------- */
const _colCache = new Map();
function parseColor(s){
  if(typeof s !== 'string') return null;
  let c = _colCache.get(s);
  if(c) return c;
  c = _parse(s);
  if(_colCache.size > 4096) _colCache.clear();   /* colours are template-built per frame ("rgba(255,214,106,"+a+")"), so this map is unbounded by nature -- cap it rather than leak a session */
  _colCache.set(s, c);
  return c;
}
function _parse(s){
  s = s.trim();
  if(s[0] === '#'){
    let h = s.slice(1);
    if(h.length === 3) h = h[0]+h[0]+h[1]+h[1]+h[2]+h[2];
    const n = parseInt(h, 16);
    if(h.length === 6) return [((n>>16)&255)/255, ((n>>8)&255)/255, (n&255)/255, 1];
    if(h.length === 8) return [((n>>>24)&255)/255, ((n>>16)&255)/255, ((n>>8)&255)/255, (n&255)/255];
    return [1,0,1,1];
  }
  const m = /^rgba?\(([^)]+)\)$/i.exec(s);
  if(m){
    const p = m[1].split(',');
    return [ (+p[0])/255, (+p[1])/255, (+p[2])/255, p.length > 3 ? +p[3] : 1 ];
  }
  if(s === 'transparent') return [0,0,0,0];
  return [1,0,1,1];   /* magenta: an unparsed colour should be LOUD, never silently black */
}

/* ---------- gradients ---------- */
function Gradient(kind, a){ this.kind = kind; this.a = a; this.stops = []; }
Gradient.prototype.addColorStop = function(t, col){
  this.stops.push([t, parseColor(col)]);
  this.stops.sort((x,y)=>x[0]-y[0]);
};
Gradient.prototype.at = function(t){
  const st = this.stops;
  if(!st.length) return [0,0,0,1];
  if(t <= st[0][0]) return st[0][1];
  if(t >= st[st.length-1][0]) return st[st.length-1][1];
  for(let i=1;i<st.length;i++){
    if(t <= st[i][0]){
      const a = st[i-1], b = st[i];
      const f = (t - a[0]) / Math.max(1e-6, b[0]-a[0]);
      return [ a[1][0]+(b[1][0]-a[1][0])*f, a[1][1]+(b[1][1]-a[1][1])*f,
               a[1][2]+(b[1][2]-a[1][2])*f, a[1][3]+(b[1][3]-a[1][3])*f ];
    }
  }
  return st[st.length-1][1];
};

/* ---------- shaders ----------
   The lens lives HERE, as a vertex displacement, which is the whole point of the
   exercise: warping geometry costs a few ALU ops per vertex and is flat in k, where
   warping PIXELS cost ~7ms per megapixel of buffer on iOS at any k.
   g(rd) maps a screen radius to the LARGER source radius it samples, so as a vertex
   transform it is the inverse -- a vertex at radius R lands nearer the centre, which
   is what pulls more field into view.                                            */
const VS = `
attribute vec2 aPos; attribute vec4 aCol;
uniform vec2 uRes; uniform float uK, uFlat, uDR, uCorner, uAxis;
varying vec4 vCol; varying vec2 vPos;
void main(){
  vec2 p = aPos;
  if(uK > 0.0){
    /* ROUNDED-RECTANGLE FIELD -- must stay identical to lensRectField() in the page, which xy() and
       glWarpPt() also read. The flat pane is a rounded rect with the SCREEN'S proportions; outside it
       the geometry is pulled IN along that shape's outward normal, so every edge bends into its own
       horizon instead of everything being dragged toward one point. Radial before, and a disc inside
       a 2.4:1 frame reaches the sides long before the top, which is why it read as a rolling wave. */
    vec2 c = uRes * 0.5;
    vec2 d = p - c;
    /* SHORT-AXIS BIAS (uAxis). At 0 the flat pane keeps the screen's proportions and all four
       edges bend, which is the shape shipped in b309. At 1 the LONG axis's half of the pane is
       relaxed all the way out to the screen edge, so those two edges never leave the flat pane
       and only the short dimension bends. step() is strict, so a square screen ignores the dial
       entirely rather than flattening both axes into no lens at all. Note this also collapses
       dMax below -- the corner it normalises against comes in, so u reaches ~1 at the short
       edge where it used to reach ~0.3, and the SAME uK bends visibly harder. That is the
       point, not a side effect: the bend stops being spent on edges that had field to spare. */
    vec2 lng = step(c.yx + vec2(1e-4), c);
    vec2 H = c * (uFlat + (1.0 - uFlat) * (uAxis * lng));
    float r = uCorner * min(H.x, H.y);
    vec2 e = max(H - vec2(r), vec2(0.0));
    vec2 q = max(abs(d) - e, vec2(0.0));
    float L = length(q);
    float dMax = max(length(c - e) - r, 1e-4);
    float dist = L - r;
    if(dist > 0.0 && L > 1e-6){
      /* d/(1+k*d/dMax) -- mirrors lensSquash() in the page. Deliberately NOT k*u*u*dMax: that form
         folds above k=0.5 (derivative 1-2k*u) and the image maps back through itself, which cost
         197px of tap error at k=0.7 before it was caught. This one's derivative is 1/(1+k*u)^2,
         positive everywhere, so it can never fold and inverts in closed form for the hit-test. */
      float shift = dist - dist / (1.0 + uK * dist / dMax);
      vec2 n = q / L * sign(d);
      p -= n * shift;
    }
  }
  vCol = aCol;
  vPos = p;   /* POST-warp device position, so a clip region follows the lens the same way the geometry does */
  vec2 n = p / uRes * 2.0 - 1.0;
  gl_Position = vec4(n.x, -n.y, 0.0, 1.0);
}`;
const FS = `
precision mediump float;
varying vec4 vCol; varying vec2 vPos;
uniform int uClipN; uniform vec3 uClip[8];
void main(){
  /* CLIP AS A UNION OF DISCS. The only clip in the world layer is the fringe
     sighting mask: a partially spotted enemy is shown only where you actually
     hold their body, as a union of at most seven equal-radius discs (hex centre
     plus six directions). Treating clip() as a no-op does not just look wrong,
     it LEAKS -- the whole enemy renders when you have a sliver of them. */
  if(uClipN > 0){
    bool inside = false;
    for(int i = 0; i < 8; i++){
      if(i >= uClipN) break;
      if(distance(vPos, uClip[i].xy) <= uClip[i].z){ inside = true; break; }
    }
    if(!inside) discard;
  }
  gl_FragColor = vec4(vCol.rgb * vCol.a, vCol.a);
}`;   /* premultiplied: blendFunc(ONE, ONE_MINUS_SRC_ALPHA) so stacked translucent motifs composite the way Canvas2D's source-over does */

function compile(gl, type, src){
  const s = gl.createShader(type);
  gl.shaderSource(s, src); gl.compileShader(s);
  if(!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('shader: ' + gl.getShaderInfoLog(s));
  return s;
}

/* ---------- perf knobs -----------------------------------------------------
   WHY THESE EXIST. The first device measurement of this backend came in 3.5x
   SLOWER than the Canvas2D renderer it replaces (39.66ms vs 11.34ms a frame on
   an iPhone 17 Pro Max). The obvious culprit was CPU tessellation -- 90% of a
   frame's triangles are board and wall geometry rebuilt from scratch every
   frame -- but the device numbers carried a signal pointing elsewhere: frame
   time FELL ~2.4ms as the lens strength rose, at identical vertex, triangle and
   byte counts. The lens pulls geometry inward, so it covers fewer pixels. Time
   falling with covered AREA is a fragment-cost tell, not a vertex-cost one.
   Rather than spend a week on a static-VBO redesign that a fragment bottleneck
   would render pointless, each suspect gets a switch and one device session
   decides. `aa` is read at context-creation time and so needs a reload to
   change; the rest are live. Seeded from localStorage so a device run can be
   configured without a console. */
/* Perf knobs, all defaulting to the plain path. MEASURED ON DEVICE 2026-08-24
   and left off deliberately: at 43k tris the GL layer costs ~2.3ms a draw
   against Canvas2D's ~22ms, so every one of these lands inside measurement
   noise (sub 2.88/2.25/1.75 vs baseline 2.56/2.31/1.78 across three passes).
   Nothing here is worth turning on -- the renderer is already ~10x under
   budget. They stay as instrumentation for the next time something IS slow. */
const _glTune = { aa:true, sub:false, scale:1, noUpload:false, frozen:false, noTess:false, forceLost:false, bench:false, lensSeg:64 };   /* lensSeg: device px between vertices inserted into a long stroke so the lens has a curve to bend -- see lensSubdivide. MEASURED, not guessed: at 22px a board frame went 51.4k -> 75.8k triangles (+48%), because every hex edge is long enough to get cut and each inserted vertex also mints a round joint. At 64px the same frame goes 51.1k -> 52.9k (+3.6%) and a full-width line still tracks the true field to 0.75px at the shipped dial (3.5px at k=0.7, twice it) -- the bend it has to follow is 18px, so that is invisible. The cost is in the count of CUT strokes, not in the cuts themselves. */
try{
  const s = localStorage.getItem('hsl_gltune');
  if(s) Object.assign(_glTune, JSON.parse(s));
}catch(e){}

/* ---------- the context-alike ---------- */
function create(canvas){
  const CLIP_MAX = 8;
  const _clipBuf = new Float32Array(CLIP_MAX*3);
  let gl, prog, U, u32, IDXTYPE, vbo, ebo;

  /* CONTEXT SETUP IS A FUNCTION, NOT STRAIGHT-LINE CODE, for exactly one
     reason: `antialias` is fixed when a context is created and getContext on a
     canvas that already has one returns the ORIGINAL attributes, ignoring the
     ones you pass. Measuring MSAA therefore needs a brand new canvas element.
     Doing that here -- rather than by reloading the page -- keeps the whole
     comparison inside a single match on a device whose UI cannot be scripted,
     and a match restart per variant is the expensive part of this loop. */
  function buildContext(cv, aa){
    const attr = {alpha:true, antialias:!!aa, depth:false, stencil:false, premultipliedAlpha:true, preserveDrawingBuffer:true};   /* THE BLINKING BOARD (Ian 2026-08-25, iPhone, build 310: "the gpu board on brings the blinking back"; off, it is clean). Without this the drawing buffer's contents are UNDEFINED after every composite -- in practice cleared -- so a presented frame that was not redrawn shows an empty world layer while the 2D text overlay above it keeps its pixels. loop() skips drawing constantly by design: it registers a rAF every display frame but bails under the 25ms frame cap, and drops to a 100ms cadence on a settled board. Against a 60/120Hz iPhone panel that is most presented frames, which is the blink. A 2D canvas retains its pixels indefinitely, which is exactly why turning the GPU board off cured it. The invariant is structural: a non-preserving drawing buffer must be redrawn on EVERY presented frame, and this loop deliberately does not -- so the buffer has to preserve instead. The alternative (draw every rAF whenever GL is live) spends the battery budget the idle throttle exists to protect, for a board that is not moving. */
    const g = cv.getContext('webgl2', attr) || cv.getContext('webgl', attr);
    if(!g) return false;
    gl = g;
    prog = gl.createProgram();
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FS));
    gl.bindAttribLocation(prog, 0, 'aPos');
    gl.bindAttribLocation(prog, 1, 'aCol');
    gl.linkProgram(prog);
    if(!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error('link: ' + gl.getProgramInfoLog(prog));
    gl.useProgram(prog);
    U = { res:  gl.getUniformLocation(prog,'uRes'), k: gl.getUniformLocation(prog,'uK'),
          flat: gl.getUniformLocation(prog,'uFlat'), dr: gl.getUniformLocation(prog,'uDR'), corner: gl.getUniformLocation(prog,'uCorner'), axis: gl.getUniformLocation(prog,'uAxis'),
          clipN: gl.getUniformLocation(prog,'uClipN'), clip: gl.getUniformLocation(prog,'uClip') };
    u32 = (typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext)
          || !!gl.getExtension('OES_element_index_uint');
    IDXTYPE = u32 ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT;
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.DEPTH_TEST);
    vbo = gl.createBuffer(); ebo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ebo);
    gl.enableVertexAttribArray(0); gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 24, 0);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 24, 8);
    return true;
  }
  if(!buildContext(canvas, _glTune.aa)) return null;

  let V = new Float32Array(1 << 18);          /* interleaved x,y,r,g,b,a */
  let I = u32 ? new Uint32Array(1 << 18) : new Uint16Array(1 << 16);
  let vn = 0, inn = 0;
  let CW = canvas.width, CH = canvas.height;
  let _vboBytes = 0, _eboBytes = 0;   /* current GPU store sizes, so bufferSubData can reuse an allocation instead of bufferData reallocating one every frame */
  let _frozen = null;                 /* measurement stub: a captured frame replayed without re-upload -- the static-VBO best case */
  _frozenReset = ()=>{ _frozen = null; _vboBytes = 0; _eboBytes = 0; };

  /* transform: [a,b,c,d,e,f] applied on the CPU so every shape can share one draw call */
  let M = [1,0,0,1,0,0];
  const stack = [];

  /* ---- lens subdivision ------------------------------------------------
     THE LENS BENDS VERTICES, SO A TWO-POINT LINE CANNOT BEND (Ian 2026-08-25:
     "the red laser and the blue laser seem to be on different layers ... when
     the image starts to warp towards the edge of the screen they separate from
     each other, the red laser stays in a straight line").
     They were never on different layers. Everything here goes through the one
     vertex shader -- but that shader can only move the vertices it is GIVEN.
     The weapon cone is a corridor of per-hex polygons, hundreds of little
     vertices, so it follows the curve exactly; the sight laser is one segment
     with an endpoint at each end, so the warp slides those two points and
     leaves the ruler-straight span between them untouched. The wider the bend,
     the further the two drift apart. Same artifact on the board rim hexagon,
     the order path and the cohesion links -- every long straight run.
     The fix is geometric, not visual: hand the shader enough vertices along a
     long segment for it to have a curve to bend. Deliberately NOT a change to
     lensRectField/lensSquash/glWarpPt -- the FIELD is correct and hit-testing
     reads it, so touching it would cost taps hundreds of px (b309). */
  const LENS_SEG_MAX = 32;  /* a board-spanning line can't mint unbounded geometry */
  let _lens = null;
  function lensFlatInside(x, y){
    /* mirrors the shader's `dist = L - r <= 0` test exactly. The flat pane is a
       CONVEX rounded rect, so both endpoints inside means the whole segment is
       inside and no point on it is displaced -- nothing to subdivide. */
    const cx = CW*0.5, cy = CH*0.5, _ax = _lens.axis||0;
    const _lx = cx >= cy+1e-4 ? _ax : 0, _ly = cy >= cx+1e-4 ? _ax : 0;   /* MUST MATCH the shader's step(c.yx+1e-4, c) exactly. This is a SKIP test -- a segment with both ends inside the pane gains no vertices -- so a pane that is wider here than in the shader silently leaves long strokes straight through a band that is really bending. */
    const hx = cx*(_lens.flat + (1-_lens.flat)*_lx), hy = cy*(_lens.flat + (1-_lens.flat)*_ly);
    const r = _lens.corner * Math.min(hx, hy);
    const ex = Math.max(hx - r, 0), ey = Math.max(hy - r, 0);
    const qx = Math.max(Math.abs(x - cx) - ex, 0), qy = Math.max(Math.abs(y - cy) - ey, 0);
    return Math.hypot(qx, qy) - r <= 0;
  }
  function lensSubdivide(pts, closed){
    const n = pts.length/2;
    if(n < 2) return pts;
    const out = [];
    const lim = closed ? n : n-1;
    for(let i=0;i<lim;i++){
      const j = (i+1) % n;
      const x0 = pts[i*2], y0 = pts[i*2+1], x1 = pts[j*2], y1 = pts[j*2+1];
      out.push(x0, y0);
      const L = Math.hypot(x1-x0, y1-y0);
      const SEG = _glTune.lensSeg || 64;
      if(L <= SEG) continue;
      if(lensFlatInside(x0,y0) && lensFlatInside(x1,y1)) continue;
      const cuts = Math.min(LENS_SEG_MAX, Math.ceil(L / SEG)) - 1;
      for(let k=1;k<=cuts;k++){ const t = k/(cuts+1); out.push(x0 + (x1-x0)*t, y0 + (y1-y0)*t); }
    }
    if(!closed) out.push(pts[(n-1)*2], pts[(n-1)*2+1]);
    return out;
  }

  /* current paint state */
  const st = {
    fillStyle:'#000', strokeStyle:'#000', lineWidth:1, lineCap:'butt', lineJoin:'miter',
    globalAlpha:1, dash:null, font:'10px sans-serif', textAlign:'start', textBaseline:'alphabetic',
    shadowBlur:0, shadowColor:'rgba(0,0,0,0)', globalCompositeOperation:'source-over',
    miterLimit:10, lineDashOffset:0, clip:null
  };
  const textQ = [];   /* drained by the caller and painted on the 2D overlay */

  /* path accumulation: a list of subpaths, each a flat [x,y,...] in USER space */
  let subs = [], cur = null;

  function tx(x, y, out){ out[0] = M[0]*x + M[2]*y + M[4]; out[1] = M[1]*x + M[3]*y + M[5]; return out; }
  function scaleOf(){ return Math.sqrt(Math.abs(M[0]*M[3] - M[1]*M[2])) || 1; }   /* lineWidth is in USER units; the geometry is emitted in DEVICE units, so widths scale by the transform's area factor */

  function growV(n){ if((vn+n)*6 > V.length){ const t = new Float32Array(Math.max(V.length*2,(vn+n)*6)); t.set(V); V = t; } }
  function growI(n){
    if(inn+n > I.length){
      const cap = Math.max(I.length*2, inn+n);
      if(!u32 && cap > 65535) return false;   /* 16-bit index space is a hard ceiling; flush instead of overflowing */
      const t = u32 ? new Uint32Array(cap) : new Uint16Array(cap); t.set(I); I = t;
    }
    return true;
  }
  function vert(x, y, c, a){
    const o = vn*6;
    V[o]=x; V[o+1]=y; V[o+2]=c[0]; V[o+3]=c[1]; V[o+4]=c[2]; V[o+5]=c[3]*a;
    return vn++;
  }

  const _p = [0,0];
  let _clipWarned = 0;

  /* BLEND RANGES. globalCompositeOperation='lighter' is what makes a bolt read as
     a glow rather than a smear, and the world layer uses it on shot tracers and
     warp FX. One draw call cannot carry two blend modes, so geometry is split
     into ordered ranges and replayed in painter order -- still one buffer, just
     several drawElements. Anything other than 'lighter' composites as source-over. */
  let ranges = [{mode:'source-over', clip:null, start:0, count:0}];
  function rangeFor(mode, clip){
    const r = ranges[ranges.length-1];
    if(r.mode === mode && r.clip === clip) return r;
    if(r.count === 0){ r.mode = mode; r.clip = clip; return r; }
    const nr = {mode, clip, start: inn, count: 0};
    ranges.push(nr);
    return nr;
  }
  function openRange(){
    const r = rangeFor(st.globalCompositeOperation === 'lighter' ? 'lighter' : 'source-over', st.clip || null);
    r._mark = inn; return r;
  }
  function closeRange(r){ r.count += inn - r._mark; }

  /* PAINT RESOLUTION. A gradient's coordinates live in the user space in effect
     when it is PAINTED, not when it was created, so the endpoints transform here.
     Linear gradients need no extra tessellation: barycentric interpolation of a
     linear ramp across a triangle is exact. Radial ones are non-linear in the
     plane and get their own mesh -- see emitRadialMesh. */
  function makePaint(style){
    if(style instanceof Gradient){
      if(style.kind === 'linear'){
        const a = style.a;
        tx(a[0], a[1], _p); const x0 = _p[0], y0 = _p[1];
        tx(a[2], a[3], _p); const x1 = _p[0], y1 = _p[1];
        const dx = x1-x0, dy = y1-y0, L2 = (dx*dx + dy*dy) || 1;
        const tf = (x,y) => ((x-x0)*dx + (y-y0)*dy) / L2;
        return {col:null, cf:(x,y) => style.at(tf(x,y)), tf, grad:style};
      }
      const a = style.a, sc = scaleOf();
      tx(a[3], a[4], _p); const cxD = _p[0], cyD = _p[1];
      const r0 = a[2]*sc, span = Math.max(1e-6, a[5]*sc - a[2]*sc);
      return {col:null, cf:(x,y) => style.at((Math.hypot(x-cxD, y-cyD) - r0) / span)};
    }
    const c = parseColor(style);
    return c && c[3] > 0 ? {col:c, cf:null} : null;
  }

  /* ---- geometry emitters (device space) ---- */
  function emitFan(pts, col, alpha, cf){
    const n = pts.length/2;
    if(n < 3) return;
    growV(n); if(!growI((n-2)*3)) return;
    const b = vn;
    if(cf) for(let i=0;i<n;i++){ const x=pts[i*2], y=pts[i*2+1]; vert(x, y, cf(x,y), alpha); }
    else   for(let i=0;i<n;i++) vert(pts[i*2], pts[i*2+1], col, alpha);
    for(let i=1;i<n-1;i++){ I[inn++]=b; I[inn++]=b+i; I[inn++]=b+i+1; }
  }
  /* A RADIAL GRADIENT NEEDS ITS OWN MESH, NOT PER-VERTEX COLOUR ON THE SHAPE.
     Colouring the path's existing vertices renders the background gradient FLAT:
     fillRect gives four corners, every one of them past the outer stop, so the
     interior interpolates between four identical colours. Measured: the centre
     came out rgb(18,11,40) where Canvas2D paints rgb(36,26,72).
     So fan from the gradient CENTRE and subdivide each wedge radially -- the
     interior then carries real vertices at real radii. Exact for convex paths
     containing the centre, which is every radial-gradient site in the world
     layer (backgrounds and glows, all centred in their own shape). */
  /* A MULTI-STOP GRADIENT FILL NEEDS SUBDIVISION, NOT JUST PER-VERTEX COLOUR.
     t is linear in space, so barycentric interpolation carries t exactly -- but
     the COLOUR is a piecewise-linear function OF t, and interpolating colour
     straight between two vertices jumps clean over any stop between them. A
     three-stop ramp across a rect measured 57% of pixels wrong for exactly this.
     So split each triangle until the t it spans is narrower than the tightest
     gap between adjacent stops. */
  function emitTriGrad(x0,y0,x1,y1,x2,y2, tf, grad, alpha, thresh, depth){
    const t0 = tf(x0,y0), t1 = tf(x1,y1), t2 = tf(x2,y2);
    const spread = Math.max(t0,t1,t2) - Math.min(t0,t1,t2);
    if(depth <= 0 || spread <= thresh){
      growV(3); if(!growI(3)) return;
      const b = vn;
      vert(x0,y0, grad.at(t0), alpha);
      vert(x1,y1, grad.at(t1), alpha);
      vert(x2,y2, grad.at(t2), alpha);
      I[inn++]=b; I[inn++]=b+1; I[inn++]=b+2;
      return;
    }
    const ax=(x0+x1)/2, ay=(y0+y1)/2, bx=(x1+x2)/2, by=(y1+y2)/2, cx2=(x2+x0)/2, cy2=(y2+y0)/2;
    emitTriGrad(x0,y0, ax,ay, cx2,cy2, tf,grad,alpha,thresh,depth-1);
    emitTriGrad(ax,ay, x1,y1, bx,by,   tf,grad,alpha,thresh,depth-1);
    emitTriGrad(cx2,cy2, bx,by, x2,y2, tf,grad,alpha,thresh,depth-1);
    emitTriGrad(ax,ay, bx,by, cx2,cy2, tf,grad,alpha,thresh,depth-1);
  }
  function stopThresh(grad){
    let g = 1;
    for(let i=1;i<grad.stops.length;i++) g = Math.min(g, grad.stops[i][0] - grad.stops[i-1][0]);
    return Math.max(0.02, g/2);
  }
  function emitFanGradSub(pts, tf, grad, alpha){
    const n = pts.length/2;
    if(n < 3) return;
    const th = stopThresh(grad);
    for(let i=1;i<n-1;i++)
      emitTriGrad(pts[0],pts[1], pts[i*2],pts[i*2+1], pts[(i+1)*2],pts[(i+1)*2+1], tf, grad, alpha, th, 4);
  }
  function emitRadialMesh(pts, grad, alpha, cxD, cyD, r0, r1){
    const n = pts.length/2;
    if(n < 3) return;
    const span = Math.max(1e-6, r1 - r0);
    /* rings sized from the gradient's DEVICE extent, ~10px apart: a hex-sized
       glow and a full-screen background must not get the same band budget, or
       the big one bands visibly (measured max|d| 14/255 at a flat 10). */
    const GRAD_BANDS = Math.max(6, Math.min(64, Math.ceil(span/10)));
    const colAt = (x,y) => grad.at(Math.max(0, Math.min(1, (Math.hypot(x-cxD,y-cyD) - r0)/span)));

    /* DENSIFY BY ANGLE FIRST. A rect has four vertices, so each wedge spans 90
       degrees and colour interpolates across it in a straight line while the
       true radius does not -- corners came out exact and mid-edges off by 12/255,
       which on the background gradient is a visible dark cross. Split every edge
       until no piece subtends more than ~10 degrees at the centre. */
    const D = [];
    for(let i=0;i<n;i++){
      const j = (i+1) % n;
      const ax = pts[i*2], ay = pts[i*2+1], bx = pts[j*2], by = pts[j*2+1];
      const a0 = Math.atan2(ay-cyD, ax-cxD), a1 = Math.atan2(by-cyD, bx-cxD);
      let da = Math.abs(a1-a0); if(da > Math.PI) da = Math.PI*2 - da;
      const m = Math.max(1, Math.min(24, Math.ceil(da/(Math.PI/18))));
      for(let k=0;k<m;k++){ const t = k/m; D.push(ax+(bx-ax)*t, ay+(by-ay)*t); }
    }
    const dn = D.length/2;
    for(let i=0;i<dn;i++){
      const j = (i+1) % dn;
      const x0 = D[i*2], y0 = D[i*2+1], x1 = D[j*2], y1 = D[j*2+1];
      growV((GRAD_BANDS+1)*2); if(!growI(GRAD_BANDS*6)) return;
      let pa = vert(cxD, cyD, colAt(cxD,cyD), alpha);
      let pb = pa;
      for(let k=1;k<=GRAD_BANDS;k++){
        const t = k/GRAD_BANDS;
        const ax = cxD + (x0-cxD)*t, ay = cyD + (y0-cyD)*t;
        const bx = cxD + (x1-cxD)*t, by = cyD + (y1-cyD)*t;
        const na = vert(ax, ay, colAt(ax,ay), alpha);
        const nb = vert(bx, by, colAt(bx,by), alpha);
        I[inn++]=pa; I[inn++]=na; I[inn++]=nb;
        if(k > 1){ I[inn++]=pa; I[inn++]=nb; I[inn++]=pb; }
        pa = na; pb = nb;
      }
    }
  }
  function emitSeg(x0,y0,x1,y1,hw,col,alpha,cf){
    const dx = x1-x0, dy = y1-y0, l = Math.hypot(dx,dy);
    if(l < 1e-6) return;
    const nx = -dy/l*hw, ny = dx/l*hw;
    growV(4); if(!growI(6)) return;
    const b = vn;
    const cA = cf ? cf(x0,y0) : col, cB = cf ? cf(x1,y1) : col;
    vert(x0+nx, y0+ny, cA, alpha); vert(x0-nx, y0-ny, cA, alpha);
    vert(x1-nx, y1-ny, cB, alpha); vert(x1+nx, y1+ny, cB, alpha);
    I[inn++]=b; I[inn++]=b+1; I[inn++]=b+2;
    I[inn++]=b; I[inn++]=b+2; I[inn++]=b+3;
  }
  const JOINT_N = 6;
  function emitJoint(x,y,hw,col,alpha,cf){
    if(hw < 0.7) return;   /* below a pixel a round join is invisible and pure cost -- the board is mostly hairlines */
    growV(JOINT_N+1); if(!growI(JOINT_N*3)) return;
    const b = vn;
    const c = cf ? cf(x,y) : col;
    vert(x,y,c,alpha);
    for(let k=0;k<=JOINT_N;k++){ const a = k/JOINT_N*Math.PI*2; vert(x+hw*Math.cos(a), y+hw*Math.sin(a), c, alpha); }
    for(let k=0;k<JOINT_N;k++){ I[inn++]=b; I[inn++]=b+1+k; I[inn++]=b+2+k; }
  }
  function emitStroke(pts, closed, hw, col, alpha, dash, cap, cf, dashOff){
    const n = pts.length/2;
    if(n < 2){
      if(n === 1 && cap === 'round') emitJoint(pts[0], pts[1], hw, col, alpha, cf);
      return;
    }
    const lim = closed ? n : n-1;
    if(!dash || !dash.length){
      for(let i=0;i<lim;i++){
        const j = (i+1) % n;
        emitSeg(pts[i*2], pts[i*2+1], pts[j*2], pts[j*2+1], hw, col, alpha, cf);
      }
      if(hw > 0.75){
        const first = closed ? 0 : 1, last = closed ? n : n-1;
        for(let i=first;i<last;i++) emitJoint(pts[i*2], pts[i*2+1], hw, col, alpha, cf);
        if(!closed && cap === 'round'){ emitJoint(pts[0],pts[1],hw,col,alpha,cf); emitJoint(pts[(n-1)*2],pts[(n-1)*2+1],hw,col,alpha,cf); }
      }
      return;
    }
    /* dashes are cut on the CPU, phase carried across segments the way Canvas2D does.
       lineDashOffset is what animates marching ants along a lane (the file sets
       -t*22); ignoring it froze the pattern and showed up as a solid mismatched
       line down the whole lane rather than as a subtle phase error. */
    let di = 0, on = true, rem = dash[0];
    if(dashOff){
      const total = dash.reduce((a,b)=>a+b,0) || 1;
      let o = dashOff % total; if(o < 0) o += total;
      while(o >= dash[di]){ o -= dash[di]; di = (di+1) % dash.length; on = !on; }
      rem = dash[di] - o;
    }
    for(let i=0;i<lim;i++){
      const j = (i+1) % n;
      let x0 = pts[i*2], y0 = pts[i*2+1];
      const x1 = pts[j*2], y1 = pts[j*2+1];
      let dx = x1-x0, dy = y1-y0;
      const L = Math.hypot(dx,dy);
      if(L < 1e-6) continue;
      dx/=L; dy/=L;
      let t = 0;
      while(t < L){
        const run = Math.min(rem, L-t);
        if(on) emitSeg(x0+dx*t, y0+dy*t, x0+dx*(t+run), y0+dy*(t+run), hw, col, alpha, cf);
        t += run; rem -= run;
        if(rem <= 1e-9){ di = (di+1) % dash.length; rem = dash[di]; on = !on; }
      }
    }
  }

  /* ---- path building (user space in, device space stored) ---- */
  function ensure(){ if(!cur){ cur = {pts:[], closed:false}; subs.push(cur); } return cur; }
  function flattenArc(cxU, cyU, r, a0, a1, ccw, out){
    let span = a1 - a0;
    if(ccw){ while(span > 0) span -= Math.PI*2; if(span < -Math.PI*2) span = -Math.PI*2; }
    else   { while(span < 0) span += Math.PI*2; if(span >  Math.PI*2) span =  Math.PI*2; }
    const rDev = r * scaleOf();
    const steps = Math.max(4, Math.min(64, Math.ceil(Math.abs(span) / (Math.PI*2) * (8 + rDev*0.55))));   /* segment count from DEVICE radius: a hex-sized ring and a board-sized ring must not get the same budget */
    for(let i=0;i<=steps;i++){
      const a = a0 + span*(i/steps);
      tx(cxU + Math.cos(a)*r, cyU + Math.sin(a)*r, _p);
      out.push(_p[0], _p[1]);
    }
  }

  /* replay a recorded Path2D through the shim's own path builders, so it lands
     in device space under the CURRENT transform -- which is exactly what
     Canvas2D does with a Path2D at paint time */
  function buildFromRec(rec){
    const sSubs = subs, sCur = cur;
    subs = []; cur = null;
    for(let i=0;i<rec.length;){
      const op = rec[i++];
      if(op === OP_M){ api.moveTo(rec[i], rec[i+1]); i+=2; }
      else if(op === OP_L){ api.lineTo(rec[i], rec[i+1]); i+=2; }
      else if(op === OP_C){ api.closePath(); }
      else if(op === OP_RECT){ api.rect(rec[i],rec[i+1],rec[i+2],rec[i+3]); i+=4; }
      else if(op === OP_ARC){ api.arc(rec[i],rec[i+1],rec[i+2],rec[i+3],rec[i+4],!!rec[i+5]); i+=6; }
      else if(op === OP_Q){ api.quadraticCurveTo(rec[i],rec[i+1],rec[i+2],rec[i+3]); i+=4; }
      else if(op === OP_B){ api.bezierCurveTo(rec[i],rec[i+1],rec[i+2],rec[i+3],rec[i+4],rec[i+5]); i+=6; }
      else if(op === OP_E){ api.ellipse(rec[i],rec[i+1],rec[i+2],rec[i+3],rec[i+4],rec[i+5],rec[i+6],!!rec[i+7]); i+=8; }
      else break;   /* unknown opcode: stop rather than desynchronise the stream */
    }
    const built = subs;
    subs = sSubs; cur = sCur;
    return built;
  }
  function pathArg(a){ return (a && a.__rec) ? buildFromRec(a.__rec) : null; }

  const api = {
    _isGfx: true,
    canvas: canvas,

    /* ---- state ---- */
    save(){ stack.push({ M: M.slice(), st: Object.assign({}, st) }); },
    restore(){
      const s = stack.pop();
      if(!s) return;
      M = s.M;
      Object.assign(st, s.st);
    },
    translate(x,y){ M = [M[0], M[1], M[2], M[3], M[0]*x + M[2]*y + M[4], M[1]*x + M[3]*y + M[5]]; },
    scale(x,y){ M = [M[0]*x, M[1]*x, M[2]*y, M[3]*y, M[4], M[5]]; },
    rotate(r){
      const c = Math.cos(r), s = Math.sin(r);
      M = [M[0]*c + M[2]*s, M[1]*c + M[3]*s, M[0]*(-s) + M[2]*c, M[1]*(-s) + M[3]*c, M[4], M[5]];
    },
    transform(a,b,c,d,e,f){
      M = [M[0]*a + M[2]*b, M[1]*a + M[3]*b, M[0]*c + M[2]*d, M[1]*c + M[3]*d, M[0]*e + M[2]*f + M[4], M[1]*e + M[3]*f + M[5]];
    },
    setTransform(a,b,c,d,e,f){
      /* accepts six numbers OR a matrix-like, because _guard() saves the
         transform BY VALUE (ctx.getTransform()) and hands the object straight
         back on a throw -- restoring by value rather than by save/restore is
         deliberate there, so both call shapes have to work */
      if(a && typeof a === 'object'){ M = [a.a, a.b, a.c, a.d, a.e, a.f]; return; }
      M = [a,b,c,d,e,f];
    },
    getTransform(){ return {a:M[0], b:M[1], c:M[2], d:M[3], e:M[4], f:M[5]}; },
    resetTransform(){ M = [1,0,0,1,0,0]; },

    /* ---- path ---- */
    beginPath(){ subs = []; cur = null; },
    closePath(){ if(cur) cur.closed = true; },
    moveTo(x,y){ cur = {pts:[], closed:false}; subs.push(cur); tx(x,y,_p); cur.pts.push(_p[0], _p[1]); },
    lineTo(x,y){ ensure(); tx(x,y,_p); cur.pts.push(_p[0], _p[1]); },
    rect(x,y,w,h){
      cur = {pts:[], closed:true}; subs.push(cur);
      tx(x,y,_p);     cur.pts.push(_p[0],_p[1]);
      tx(x+w,y,_p);   cur.pts.push(_p[0],_p[1]);
      tx(x+w,y+h,_p); cur.pts.push(_p[0],_p[1]);
      tx(x,y+h,_p);   cur.pts.push(_p[0],_p[1]);
      cur = null;
    },
    arc(x,y,r,a0,a1,ccw){ ensure(); flattenArc(x,y,r,a0,a1,!!ccw,cur.pts); },
    ellipse(x,y,rx,ry,rot,a0,a1,ccw){
      ensure();
      let span = a1 - a0;
      if(ccw){ while(span > 0) span -= Math.PI*2; } else { while(span < 0) span += Math.PI*2; }
      const steps = Math.max(6, Math.min(64, Math.ceil(Math.abs(span)/(Math.PI*2) * (10 + Math.max(rx,ry)*scaleOf()*0.5))));
      const cr = Math.cos(rot||0), sr = Math.sin(rot||0);
      for(let i=0;i<=steps;i++){
        const a = a0 + span*(i/steps), ex = Math.cos(a)*rx, ey = Math.sin(a)*ry;
        tx(x + ex*cr - ey*sr, y + ex*sr + ey*cr, _p);
        cur.pts.push(_p[0], _p[1]);
      }
    },
    quadraticCurveTo(cpx,cpy,x,y){
      ensure();
      const n = cur.pts.length;
      const x0 = n ? cur.pts[n-2] : 0, y0 = n ? cur.pts[n-1] : 0;   /* already device space */
      tx(cpx,cpy,_p); const c1x=_p[0], c1y=_p[1];
      tx(x,y,_p);     const x1=_p[0],  y1=_p[1];
      const steps = 12;
      for(let i=1;i<=steps;i++){
        const t = i/steps, mt = 1-t;
        cur.pts.push(mt*mt*x0 + 2*mt*t*c1x + t*t*x1, mt*mt*y0 + 2*mt*t*c1y + t*t*y1);
      }
    },
    bezierCurveTo(c1x,c1y,c2x,c2y,x,y){
      ensure();
      const n = cur.pts.length;
      const x0 = n ? cur.pts[n-2] : 0, y0 = n ? cur.pts[n-1] : 0;
      tx(c1x,c1y,_p); const a1=_p[0], b1=_p[1];
      tx(c2x,c2y,_p); const a2=_p[0], b2=_p[1];
      tx(x,y,_p);     const x1=_p[0], y1=_p[1];
      const steps = 16;
      for(let i=1;i<=steps;i++){
        const t=i/steps, mt=1-t;
        cur.pts.push(mt*mt*mt*x0 + 3*mt*mt*t*a1 + 3*mt*t*t*a2 + t*t*t*x1,
                     mt*mt*mt*y0 + 3*mt*mt*t*b1 + 3*mt*t*t*b2 + t*t*t*y1);
      }
    },

    /* ---- paint ---- */
    fill(arg){
      if(_glTune.noTess) return;   /* measurement stub: see _glTune */
      const a = st.globalAlpha;
      const target = pathArg(arg) || subs;
      if(a <= 0 || !target.length) return;
      const style = st.fillStyle;
      const r = openRange();
      if(style instanceof Gradient && style.kind === 'radial'){
        const ga = style.a, sc = scaleOf();
        tx(ga[3], ga[4], _p);           /* outer circle centre, in device space */
        for(const sp of target) emitRadialMesh(sp.pts, style, a, _p[0], _p[1], ga[2]*sc, ga[5]*sc);
        closeRange(r); return;
      }
      const paint = makePaint(style);
      if(!paint){ closeRange(r); return; }
      if(paint.tf){ for(const sp of target) emitFanGradSub(sp.pts, paint.tf, paint.grad, a); closeRange(r); return; }
      for(const sp of target) emitFan(sp.pts, paint.col, a, paint.cf);
      closeRange(r);
    },
    stroke(arg){
      if(_glTune.noTess) return;   /* measurement stub: see _glTune */
      const a = st.globalAlpha;
      const target = pathArg(arg) || subs;
      if(a <= 0 || !target.length) return;
      const paint = makePaint(st.strokeStyle);
      if(!paint) return;
      const sc = scaleOf();
      /* SUB-PIXEL STROKES ARE AN ALPHA PROBLEM, NOT A WIDTH PROBLEM. Canvas2D
         paints a 0.4px line as a 1px line at 40% coverage. Clamping the geometry
         to a minimum width instead draws it SOLID, which turned the wall-shard
         seams -- deliberately thin, ~2.5px in a ~7px band -- into bright bars
         across every wall, and put a haze of over-bright hairlines on the whole
         board. Below one device pixel, hold the width at 1 and scale alpha. */
      let wDev = st.lineWidth * sc, aMul = 1;
      if(wDev < 1){ aMul = Math.max(0.02, wDev); wDev = 1; }
      const hw = wDev / 2;
      const aEff = a * aMul;
      let dash = st.dash && st.dash.length ? st.dash.map(d => d*sc) : null;
      if(dash && dash.length % 2) dash = dash.concat(dash);   /* Canvas2D duplicates an odd-length pattern so on/off alternate evenly */
      const dashOff = dash ? (st.lineDashOffset || 0) * sc : 0;
      const r = openRange();
      for(const sp of target){
        const pts = (_lens && _lens.k > 0) ? lensSubdivide(sp.pts, sp.closed) : sp.pts;   /* see lensSubdivide: only long runs that actually reach the bend gain vertices, and only while the lens is on */
        emitStroke(pts, sp.closed, hw, paint.col, aEff, dash, st.lineCap, paint.cf, dashOff);
      }
      closeRange(r);
    },
    fillRect(x,y,w,h){ api.beginPath(); api.rect(x,y,w,h); api.fill(); },
    strokeRect(x,y,w,h){ api.beginPath(); api.rect(x,y,w,h); api.stroke(); },
    clearRect(){ /* the frame is cleared wholesale in begin(); a partial clear has no meaning in a batched buffer */ },

    /* ---- text: queued for the 2D overlay above, never drawn here ---- */
    fillText(t,x,y){ tx(x,y,_p); textQ.push({t:String(t), x:_p[0], y:_p[1], fill:st.fillStyle, stroke:null,
                       font:st.font, align:st.textAlign, base:st.textBaseline, alpha:st.globalAlpha, lw:0, scale:scaleOf()}); },
    strokeText(t,x,y){ tx(x,y,_p); textQ.push({t:String(t), x:_p[0], y:_p[1], fill:null, stroke:st.strokeStyle,
                       font:st.font, align:st.textAlign, base:st.textBaseline, alpha:st.globalAlpha, lw:st.lineWidth, scale:scaleOf()}); },
    measureText(t){ return {width: String(t).length * 6}; },   /* rough: the world layer only uses this for centring, and the overlay re-measures for real */

    /* ---- gradients ---- */
    createRadialGradient(x0,y0,r0,x1,y1,r1){ return new Gradient('radial', [x0,y0,r0,x1,y1,r1]); },
    createLinearGradient(x0,y0,x1,y1){ return new Gradient('linear', [x0,y0,x1,y1]); },

    setLineDash(d){ st.dash = (d && d.length) ? d.slice() : null; },
    getLineDash(){ return st.dash ? st.dash.slice() : []; },
    clip(arg){
      /* Only the disc-union form is supported, because that is the only clip the
         world layer uses. Anything else is refused OUTRIGHT rather than silently
         ignored: an unsupported clip that renders as "no clip" shows the player
         something the 2D build hides. */
      const rec = arg && arg.__rec;
      if(!rec){ st.clip = null; return; }
      const circles = [];
      let ok = true;
      for(let i=0;i<rec.length;){
        const op = rec[i++];
        if(op === OP_ARC){
          if(circles.length >= CLIP_MAX){ ok = false; break; }
          tx(rec[i], rec[i+1], _p);
          circles.push(_p[0], _p[1], rec[i+2]*scaleOf());
          i += 6;
        } else if(op === OP_C){ /* closePath between arcs is expected */ }
        else { ok = false; break; }
      }
      if(!ok || !circles.length){
        if(!_clipWarned){ _clipWarned = 1; try{ console.warn('[GL] unsupported clip path shape; geometry left unclipped'); }catch(e){} }
        st.clip = null; return;
      }
      st.clip = circles;
    },

    /* ---- frame control (not part of the Canvas2D API) ---- */
    begin(w, h, lens){
      /* RENDER SCALE. #glcv carries world GEOMETRY ONLY -- every glyph is queued
         and painted on the 2D overlay at full resolution -- so the world layer
         can render below the logical backing store and be upscaled by its CSS
         box without touching a single letterform. uRes stays LOGICAL, so the
         NDC mapping is unchanged and geometry lands in the smaller drawable on
         its own; only the viewport shrinks. */
      const rs = Math.max(0.25, Math.min(1, _glTune.scale || 1));
      const dw = Math.max(1, Math.round(w*rs)), dh = Math.max(1, Math.round(h*rs));
      if(canvas.width !== dw || canvas.height !== dh){ canvas.width = dw; canvas.height = dh; }
      CW = w; CH = h;
      gl.viewport(0,0,dw,dh);
      gl.useProgram(prog);
      gl.uniform2f(U.res, w, h);
      gl.uniform1f(U.k,    lens ? lens.k    : 0);
      gl.uniform1f(U.flat, lens ? lens.flat : 0.7);
      gl.uniform1f(U.dr,   lens ? lens.dr   : Math.hypot(w,h)/2);
      gl.uniform1f(U.axis, lens && lens.axis!=null ? lens.axis : 0);
      gl.uniform1f(U.corner, lens ? lens.corner : 0.55);   /* rounded-rect corner radius as a fraction of the flat pane's shorter half-axis; the page owns the dial (TUNE.lensCorner) */
      _lens = lens ? {k:lens.k, flat:(lens.flat!=null?lens.flat:0.7), corner:(lens.corner!=null?lens.corner:0.55), axis:(lens.axis!=null?lens.axis:0)} : null;   /* kept CPU-side too, so stroke() can subdivide long runs against the same field the shader bends -- see lensSubdivide */
      gl.clearColor(0,0,0,0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      vn = 0; inn = 0;
      ranges = [{mode:'source-over', clip:null, start:0, count:0}];
      M = [1,0,0,1,0,0];
      stack.length = 0;
      subs = []; cur = null;
      textQ.length = 0;
      st.globalAlpha = 1; st.dash = null; st.lineWidth = 1; st.clip = null;
    },
    end(){
      if(_glTune.noUpload) return {tris: inn/3, verts: vn, draws:0};   /* measurement stub: all the JS, none of the GPU */

      let src = ranges, sTris = inn/3, sVerts = vn;
      if(_glTune.frozen && _frozen){
        /* THE STATIC-VBO CEILING. The buffers are already resident and correct,
           so this frame costs exactly one drawElements per blend range and
           nothing else. If this is still slow, no amount of caching geometry on
           the CPU side will help and the bottleneck is fragments, not vertices. */
        src = _frozen.ranges; sTris = _frozen.tris; sVerts = _frozen.verts;
      } else {
        if(!inn) return {tris:0, verts:0, draws:0};
        const vBytes = vn*6*4, iBytes = inn*(u32?4:2);
        gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
        if(_glTune.sub && vBytes <= _vboBytes) gl.bufferSubData(gl.ARRAY_BUFFER, 0, V.subarray(0, vn*6));
        else { gl.bufferData(gl.ARRAY_BUFFER, _glTune.sub ? Math.max(vBytes, _vboBytes*2) : V.subarray(0, vn*6), gl.DYNAMIC_DRAW);
               if(_glTune.sub){ _vboBytes = Math.max(vBytes, _vboBytes*2); gl.bufferSubData(gl.ARRAY_BUFFER, 0, V.subarray(0, vn*6)); } }
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ebo);
        if(_glTune.sub && iBytes <= _eboBytes) gl.bufferSubData(gl.ELEMENT_ARRAY_BUFFER, 0, I.subarray(0, inn));
        else { gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, _glTune.sub ? Math.max(iBytes, _eboBytes*2) : I.subarray(0, inn), gl.DYNAMIC_DRAW);
               if(_glTune.sub){ _eboBytes = Math.max(iBytes, _eboBytes*2); gl.bufferSubData(gl.ELEMENT_ARRAY_BUFFER, 0, I.subarray(0, inn)); } }
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 24, 0);
        gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 24, 8);
        if(_glTune.frozen) _frozen = {ranges: ranges.map(r=>({mode:r.mode, clip:r.clip, start:r.start, count:r.count})), tris: inn/3, verts: vn};
      }

      const stride = u32 ? 4 : 2;
      let draws = 0, mode = null, clip = undefined;
      for(const r of src){
        if(!r.count) continue;
        if(r.mode !== mode){
          mode = r.mode;
          if(mode === 'lighter') gl.blendFunc(gl.ONE, gl.ONE);
          else gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        }
        if(r.clip !== clip){
          clip = r.clip;
          const n = clip ? Math.min(CLIP_MAX, clip.length/3) : 0;
          gl.uniform1i(U.clipN, n);
          if(n){ _clipBuf.set(clip.subarray ? clip.subarray(0,n*3) : clip.slice(0,n*3)); gl.uniform3fv(U.clip, _clipBuf); }
        }
        gl.drawElements(gl.TRIANGLES, r.count, IDXTYPE, r.start * stride);
        draws++;
      }
      if(mode === 'lighter') gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      if(clip) gl.uniform1i(U.clipN, 0);
      return {tris: sTris, verts: sVerts, draws};
    },
    textQueue(){ return textQ; },
    stats(){ return {verts: vn, tris: inn/3, bufKB: ((V.length*4 + I.length*(u32?4:2))/1024)|0}; },

    /* forceLost IS THE CANVAS2D SWITCH. glGfx() re-checks lost() on every call
       and falls back to the 2D canvas when it is true, so this flips the whole
       world layer between renderers LIVE -- no reload, no relaunch, and most
       importantly no restarting the match. On a physical device whose UI cannot
       be scripted, restarting the match is the only step that needs a human,
       so removing it is what makes a same-scene A/B possible at all. */
    lost(){ return !!_glTune.forceLost || gl.isContextLost(); },

    /* Swap MSAA by rebuilding on a fresh canvas element (see buildContext). The
       clone keeps the id, so adaptCanvasResolution still finds it by id. */
    setAA(aa){
      if(!canvas || !canvas.parentNode) return false;
      const n = canvas.cloneNode(false);
      canvas.parentNode.replaceChild(n, canvas);
      canvas = n;
      _vboBytes = 0; _eboBytes = 0; _frozen = null;
      CW = canvas.width; CH = canvas.height;
      try{ return buildContext(canvas, aa); }catch(e){ return false; }
    },
    get gl(){ return gl; }
  };

  /* plain-property state: mirrored onto st so save/restore captures them */
  ['fillStyle','strokeStyle','lineWidth','lineCap','lineJoin','globalAlpha','font',
   'textAlign','textBaseline','shadowBlur','shadowColor','globalCompositeOperation',
   'miterLimit','lineDashOffset'].forEach(k=>{
    Object.defineProperty(api, k, { get(){ return st[k]; }, set(v){ st[k] = v; }, enumerable:true });
  });

  /* OFF unless hsl_gltune.bench is set by hand. A physical device has no console
     to type into, so this is how the sweep gets driven there -- but it must
     never arm itself in a shipped build. */
  _lastApi = api;   /* the bench needs the gl handle to force a readback */
  if(_glTune.bench) setTimeout(()=>{ try{ bench(); }catch(e){ try{ console.log('[GLBENCH] failed: '+e); }catch(_){} } }, 1200);

  return api;
}

/* ---------- device bench --------------------------------------------------
   HOW THIS MEASURES, AND WHY NOT THE TWO OBVIOUS WAYS.

   Not an internal timer around draw(). performance.now() is clamped to 1ms on
   iOS WebKit and gl.finish() does not synchronise there, so a timer wrapped
   around GL calls measures COMMAND SUBMISSION and will happily report a cached
   path as slower than the uncached one it contains. That is exactly what the
   perf HUD's _perfDraw does, and it is where the "GL costs 39.66ms" figure
   this whole investigation started from came from.

   Not rAF frame interval either -- that was the first attempt and it produced
   seven identical rows of 17.00ms. Two reasons it cannot work here: the frame
   loop is deliberately throttled to FRAME_MS = 1000/40 for thermal reasons, so
   it never tries to saturate the display; and rAF ticks at the refresh rate
   regardless of how little work a frame does. Frame interval can only see cost
   that EXCEEDS the refresh interval. Everything cheaper is invisible, and
   every row pins to the cap -- the same "hitting the cap proves sufficiency,
   not margin" trap a synthetic benchmark set earlier in this same work.

   What works: drive draw() directly through window.advanceTime(0) in a timed
   burst, and force real rasterisation with a readback (gl.readPixels on the GL
   canvas, getImageData on the 2D one -- both block until the pixels exist,
   which is the flush gl.finish() refuses to be). advanceTime also serialises
   the game state on the way out, so that cost is measured SEPARATELY through
   the same render_game_to_text() and subtracted. The result is absolute ms per
   draw, independent of the refresh rate, the thermal throttle, and the 1ms
   clock clamp -- and it works identically for both renderers, which is the
   only way to compare them honestly. */
const BENCH_MODES = [
  {n:'gl baseline',        t:{}},
  {n:'gl +sub',            t:{sub:true}},
  {n:'gl scale0.70',       t:{scale:0.70}},
  {n:'gl sub+scale0.70',   t:{sub:true, scale:0.70}},   /* the actual shipping candidate: both cheap knobs together */
  {n:'gl JS-only(noUpload)',t:{noUpload:true}},
  {n:'gl frozen(no reup)', t:{frozen:true}},
  {n:'CANVAS2D',           t:{forceLost:true}},         /* live renderer swap -- see api.lost() */
];
/* frozen+noTess is deliberately NOT a row. With noTess nothing tessellates, so
   inn stays 0, end() returns before it can capture, and the "GPU only" number
   it printed last run was really "nothing drawn at all". GPU draw is derived
   instead as frozen - noUpload, which needs no stub and cannot lie that way. */
function bench(opts){
  const SETTLE = (opts&&opts.settleMs) || 260;
  const base = {sub:false, scale:1, noUpload:false, frozen:false, noTess:false, forceLost:false};
  function say(s){ try{ console.log('[GLBENCH] '+s); }catch(e){} }

  function waitForMatch(cb, tries){
    tries = tries||0;
    let live = false;
    try{
      const g = window.render_game_to_text && JSON.parse(window.render_game_to_text());
      live = !!(g && g.units && g.units.filter(u=>u.alive).length >= 4);
    }catch(e){}
    if(live) return cb();
    if(tries > 360) return say('gave up waiting for a live match');
    if(!(tries%20)) say('waiting for a live match...');
    setTimeout(()=>waitForMatch(cb, tries+1), 500);
  }

  const _px = new Uint8Array(4);
  function flush(){
    const g = _lastApi && _lastApi.gl;
    if(g){ try{ g.readPixels(0,0,1,1,g.RGBA,g.UNSIGNED_BYTE,_px); }catch(e){} }
    try{ const cv = document.getElementById('cv'); if(cv) cv.getContext('2d').getImageData(0,0,1,1); }catch(e){}
  }

  function burst(){
    for(let i=0;i<10;i++) window.advanceTime(0);   /* warm: shaders, wallArt, visibleHexSet, buffer growth, and the camera ease converges so repeats are identical */
    flush();
    let K = 8;
    for(let pass=0; pass<7; pass++){
      const t0 = performance.now();
      for(let i=0;i<K;i++) window.advanceTime(0);
      flush();
      const tFull = performance.now() - t0;
      if(tFull >= 160 || K >= 512){
        const t1 = performance.now();
        for(let i=0;i<K;i++) window.render_game_to_text();
        const tSer = performance.now() - t1;
        return { per: Math.max(0,(tFull - tSer))/K, draw: tFull/K, ser: tSer/K, K };
      }
      K *= 2;   /* too fast to resolve against a 1ms clock -- widen the window rather than trust it */
    }
    return { per:0, draw:0, ser:0, K:0 };
  }

  let sceneNote = '?';
  function snapScene(){
    const g = _lastApi && _lastApi.stats ? _lastApi.stats() : null;
    const cv = document.getElementById('cv');
    let alive = 0;
    try{ alive = JSON.parse(window.render_game_to_text()).units.filter(u=>u.alive).length; }catch(e){}
    /* SNAPSHOT DURING THE BASELINE MODE. Read at the end of the sweep instead
       and a stub mode has already zeroed vn/inn, which is how the last run
       reported a scene of "0 tris". */
    sceneNote = (g? (g.tris|0)+' tris / '+(g.verts|0)+' verts   ' : '') + (cv? cv.width+'x'+cv.height+'   ':'') + alive+' alive';
  }

  const passes = [];   /* [{label, rows:[{n,per,ser}]}] */

  /* A DISCARDED WARM PASS RUNS FIRST. Verified necessary, not defensive: the
     first recorded pass came in at 18.15ms baseline and 34.69ms for +sub
     against a ~2.2ms steady state -- shader compile, the V/I arrays doubling
     up to ~82k verts, and first-touch of a fresh GPU store, none of which a
     per-mode warm-up absorbs because each mode pays its own first time. */
  function runPass(label, done, discard, aaOn){
    const rows = [];
    (function step(i){
      if(i >= BENCH_MODES.length){ if(!discard) passes.push({label, rows, aaOn}); return done(); }
      const m = BENCH_MODES[i];
      Object.assign(_glTune, base, m.t);
      _frozenReset();
      setTimeout(()=>{
        const r = burst();
        if(i === 0) snapScene();
        rows.push({n:m.n, per:r.per, ser:r.ser});
        if(!discard) say('  '+label+'  '+m.n.padEnd(22)+r.per.toFixed(2).padStart(6)+' ms/draw   (raw '+r.draw.toFixed(2)+', ser '+r.ser.toFixed(2)+', K='+r.K+')');
        setTimeout(()=>step(i+1), 90);
      }, SETTLE);
    })(0);
  }

  function report(){
    Object.assign(_glTune, base); _frozenReset();
    say('================= RESULTS: ms per draw =================');
    say('scene: ' + sceneNote);
    const names = BENCH_MODES.map(m=>m.n);
    say('mode'.padEnd(24) + passes.map(p=>p.label.padStart(9)).join('') + '   verdict');
    for(let i=0;i<names.length;i++){
      const vals = passes.map(p=>p.rows[i] ? p.rows[i].per : NaN);
      const c2 = passes[0].rows[names.indexOf('CANVAS2D')];
      const ratio = (c2 && c2.per) ? (vals[0]/c2.per) : 0;
      say(names[i].padEnd(24) + vals.map(v=>v.toFixed(2).padStart(9)).join('') + '   ' + (ratio?(ratio.toFixed(2)+'x canvas2d'):''));
    }
    /* REPRODUCIBILITY GATE. The window subtracts two separately timed runs and
       serialisation is most of both, so a few percent of drift is the same
       size as the effects being claimed. Two passes must agree before any of
       this is worth writing down -- especially when it overturns an earlier
       conclusion. */
    if(passes.length >= 2){
      let worst = 0, worstN = '';
      for(let i=0;i<names.length;i++){
        const a = passes[0].rows[i].per, b = passes[1].rows[i].per;
        const d = Math.abs(a-b) / Math.max(0.01, (a+b)/2);
        if(d > worst){ worst = d; worstN = names[i]; }
      }
      say('reproducibility: worst pass1-vs-pass2 drift ' + (worst*100).toFixed(1) + '% on "' + worstN + '"'
          + (worst > 0.20 ? '   <-- TOO NOISY TO TRUST' : '   (acceptable)'));
    }
    /* Derive from the MINIMUM across recorded passes, not pass 0. These are
       cost floors being separated by subtraction, so an upward spike in one
       pass propagates into a nonsense component -- a contaminated first pass
       once produced "upload 16.24ms" against a 2ms frame. The minimum is the
       cleanest sample of a floor; the drift line above is what says whether to
       trust any of it. */
    const g = n=>{
      const i = names.indexOf(n); if(i < 0) return 0;
      let v = Infinity;
      for(const p of passes) if(p.aaOn && p.rows[i]) v = Math.min(v, p.rows[i].per);
      return v === Infinity ? 0 : v;
    };
    say('derived: callerJS+tess ' + g('gl JS-only(noUpload)').toFixed(2)
        + '   gpuDraw ' + (g('gl frozen(no reup)') - g('gl JS-only(noUpload)')).toFixed(2)
        + '   upload ' + (g('gl baseline') - g('gl frozen(no reup)')).toFixed(2));
    say('=======================================================');
    say('done.');   /* deliberately writes NO persistent state: a bench that leaves a flag set on a device is a bug that outlives the measurement */
  }

  waitForMatch(()=>{
    say('one launch: warm(discarded), AAon x2 (reproducibility), warm2(discarded), AAoff.');
    runPass('warm', ()=>runPass('AAon#1', ()=>runPass('AAon#2', ()=>{
      const ok = _lastApi && _lastApi.setAA && _lastApi.setAA(false);
      say('MSAA off: ' + (ok ? 'context rebuilt' : 'REBUILD FAILED - last pass still has AA on'));
      setTimeout(()=>runPass('warm2', ()=>runPass('AAoff', report, false, false), true, false), 400);
    }, false, true), false, true), true, true);
  });
}

let _lastApi = null;   /* rebound by create(); the bench needs the gl handle to force a readback */
let _frozenReset = ()=>{};   /* rebound by create() so a mode switch never replays a buffer captured under different knobs */

window.HSLGfx = { create, parseColor, Gradient, tune:_glTune, bench,
  setTune(o){ Object.assign(_glTune, o); try{ localStorage.setItem('hsl_gltune', JSON.stringify(_glTune)); }catch(e){} } };

})();
