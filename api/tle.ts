// GET /api/tle: the latest element set (TLE) of the satellite the testbed flies, relayed from
// CelesTrak's public GP service. Vercel's edge caches the answer for two hours, the refresh
// interval CelesTrak asks its clients to respect, so the site fetches from CelesTrak at most
// once per region every two hours. Failures are not cached: the browser falls back to the
// last good download it kept, then to the built-in reference orbit.

const NORAD_ID = 31698; // TerraSAR-X
const CELESTRAK = `https://celestrak.org/NORAD/elements/gp.php?CATNR=${NORAD_ID}&FORMAT=TLE`;
const USER_AGENT =
  "groundlink-testbed/1.0 (TSYP 14 secure ground-link testbed)";

function checksum(line: string): number {
  let sum = 0;
  for (const c of line.slice(0, 68)) {
    if (c >= "0" && c <= "9") sum += Number(c);
    else if (c === "-") sum += 1;
  }
  return sum % 10;
}

function fail(status: number, error: string): Response {
  return Response.json(
    { error },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

export async function GET(): Promise<Response> {
  let text: string;
  try {
    const reply = await fetch(CELESTRAK, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(8000),
    });
    text = await reply.text();
    if (!reply.ok) return fail(502, `CelesTrak answered HTTP ${reply.status}`);
  } catch (error) {
    return fail(504, `CelesTrak unreachable: ${String(error)}`);
  }

  const lines = text
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trimEnd());
  const [name, line1, line2] = lines;
  const valid =
    lines.length === 3 &&
    [line1, line2].every(
      (line, i) =>
        line.length === 69 &&
        line.startsWith(`${i + 1} `) &&
        Number(line[68]) === checksum(line) &&
        Number(line.slice(2, 7)) === NORAD_ID,
    );
  if (!valid)
    return fail(502, `unexpected CelesTrak reply: ${text.trim().slice(0, 60)}`);

  return Response.json(
    {
      name: name.trim(),
      noradId: NORAD_ID,
      line1,
      line2,
      fetchedUtc: new Date().toISOString(),
    },
    {
      headers: {
        "Cache-Control": "public, s-maxage=7200, stale-while-revalidate=86400",
      },
    },
  );
}
