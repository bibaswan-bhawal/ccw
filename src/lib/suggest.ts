/**
 * Levenshtein edit distance between two strings.
 * Used to suggest the closest command name for typos.
 */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const prev = new Array(b.length + 1);
  const curr = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        curr[j - 1] + 1, // insertion
        prev[j] + 1, // deletion
        prev[j - 1] + cost, // substitution
      );
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
  }
  return prev[b.length];
}

/**
 * Return the closest candidate to `input` within `maxDistance`, or undefined
 * if none are close enough.
 */
export function findClosestMatch(input: string, candidates: readonly string[], maxDistance = 2): string | undefined {
  let best: { name: string; distance: number } | undefined;
  const lowerInput = input.toLowerCase();
  for (const candidate of candidates) {
    const distance = editDistance(lowerInput, candidate.toLowerCase());
    if (distance <= maxDistance && (!best || distance < best.distance)) {
      best = { name: candidate, distance };
    }
  }
  return best?.name;
}
