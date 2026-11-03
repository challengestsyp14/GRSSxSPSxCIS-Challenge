// GET /api/catalog: the signal database's source, relayed from CelesTrak's public GP service.
// It holds the latest element set (TLE) of every satellite in CelesTrak's Earth-resources
// group, the observation satellites that downlink in X-band, plus TerraSAR-X, the one the
// testbed flies. The browser propagates each with SGP4 to its passes over Zaghouan and
// computes the signal every pass delivers. Vercel's edge caches the answer for two hours, the
// refresh interval CelesTrak asks its clients to respect. Failures are not cached: the browser
// falls back to the last good download it kept, then to the snapshot built into the site.

const GROUP = "resource";
const TESTBED_NORAD_ID = 31698; // TerraSAR-X
const GP = "https://celestrak.org/NORAD/elements/gp.php";
const USER_AGENT =
  "groundlink-testbed/1.0 (TSYP 14 secure ground-link testbed)";

interface Satellite {
  name: string;
  noradId: number;
  line1: string;
  line2: string;
}

function checksum(line: string): number {
  let sum = 0;
  for (const c of line.slice(0, 68)) {
    if (c >= "0" && c <= "9") sum += Number(c);
    else if (c === "-") sum += 1;
  }
  return sum % 10;
}

const validLine = (line: string, n: 1 | 2) =>
  line.length === 69 &&
  line.startsWith(`${n} `) &&
  Number(line[68]) === checksum(line);

/** Three-line element sets, each checked; malformed ones are skipped. */
function parse(text: string): Satellite[] {
  const lines = text
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
  const out: Satellite[] = [];
  for (let i = 0; i + 2 < lines.length; i += 3) {
    const [name, line1, line2] = lines.slice(i, i + 3);
    if (!line2 || !validLine(line1, 1) || !validLine(line2, 2)) continue;
    if (line1.slice(2, 7) !== line2.slice(2, 7)) continue;
    out.push({ name: name.trim(), noradId: Number(line1.slice(2, 7)), line1, line2 });
  }
  return out;
}

async function get(query: string): Promise<string> {
  const reply = await fetch(`${GP}?${query}&FORMAT=TLE`, {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(8000),
  });
  const text = await reply.text();
  if (!reply.ok) throw new Error(`CelesTrak answered HTTP ${reply.status}`);
  return text;
}

function fail(status: number, error: string): Response {
  return Response.json(
    { error },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

export async function GET(): Promise<Response> {
  let satellites: Satellite[];
  try {
    satellites = parse(await get(`GROUP=${GROUP}`));
    if (!satellites.some((s) => s.noradId === TESTBED_NORAD_ID)) {
      satellites.push(...parse(await get(`CATNR=${TESTBED_NORAD_ID}`)));
    }
  } catch (error) {
    return fail(504, `CelesTrak unreachable: ${String(error)}`);
  }
  if (satellites.length === 0) return fail(502, "CelesTrak sent no element sets");

  return Response.json(
    {
      group: GROUP,
      fetchedUtc: new Date().toISOString(),
      satellites,
    },
    {
      headers: {
        "Cache-Control": "public, s-maxage=7200, stale-while-revalidate=86400",
      },
    },
  );
}
