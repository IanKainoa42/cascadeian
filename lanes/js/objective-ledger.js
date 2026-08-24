(function (root, factory) {
  const api = factory();
  root.HSLObjectiveLedger = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
}(globalThis, function () {
  'use strict';

  function validateInputs(playerCount, allianceOf) {
    if (!Number.isInteger(playerCount) || playerCount < 0) {
      throw new RangeError('playerCount must be a nonnegative integer');
    }
    if (typeof allianceOf !== 'function') throw new TypeError('allianceOf must be a function');
  }

  function sameSide(left, right) {
    return left === right || (Number.isNaN(left) && Number.isNaN(right));
  }

  function scoreAt(values, player) {
    const score = values == null ? undefined : values[player];
    return typeof score === 'number' && Number.isFinite(score) ? score : 0;
  }

  function sideIds(playerCount, allianceOf) {
    validateInputs(playerCount, allianceOf);
    const sides = [];
    for (let player = 0; player < playerCount; player += 1) {
      const side = allianceOf(player);
      if (!sides.includes(side)) sides.push(side);
    }
    return sides;
  }

  function sumForSide(values, side, playerCount, allianceOf) {
    validateInputs(playerCount, allianceOf);
    let total = 0;
    for (let player = 0; player < playerCount; player += 1) {
      if (sameSide(allianceOf(player), side)) total += scoreAt(values, player);
    }
    return total;
  }

  function sumForTeam(values, team, playerCount, allianceOf) {
    validateInputs(playerCount, allianceOf);
    return sumForSide(values, allianceOf(team), playerCount, allianceOf);
  }

  function unionForSide(collections, side, playerCount, allianceOf) {
    validateInputs(playerCount, allianceOf);
    const members = new Set();
    for (let player = 0; player < playerCount; player += 1) {
      if (!sameSide(allianceOf(player), side)) continue;
      const collection = collections == null ? undefined : collections[player];
      if (collection != null && typeof collection[Symbol.iterator] === 'function') {
        for (const member of collection) members.add(member);
      }
    }
    return members;
  }

  function unionForTeam(collections, team, playerCount, allianceOf) {
    validateInputs(playerCount, allianceOf);
    return unionForSide(collections, allianceOf(team), playerCount, allianceOf);
  }

  function meetsTargetForTeam(values, team, target, playerCount, allianceOf) {
    validateInputs(playerCount, allianceOf);
    if (typeof target !== 'number' || !Number.isFinite(target) || target < 0) return false;
    return sumForTeam(values, team, playerCount, allianceOf) >= target;
  }

  return {
    sideIds,
    sumForSide,
    sumForTeam,
    unionForSide,
    unionForTeam,
    meetsTargetForTeam,
  };
}));
