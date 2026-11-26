/**
 * Serves S1/S3 advisory requests from a synthetic handler written for one exact GitHub query.
 * Stored-name discovery finds each target stored under its canonical name, so a discovery batch
 * clears nothing and the versioned query names the normalized or mapped package exactly as
 * before. An npm batch returns what its singleton queries would. A pip reviewed lookup arrives as an OSV query; the handler
 * answers the equivalent GitHub query and the records are returned in OSV form.
 */
type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;
type GithubRecord = {
  ghsa_id: string;
  summary: string;
  severity?: string | null;
  withdrawn_at?: string | null;
  vulnerabilities: {
    package: { ecosystem: string; name: string };
    vulnerable_version_range: string;
  }[];
};

/** `>=1.0, <2.0` style ranges as OSV events; only the operators synthetic fixtures use. */
function events(range: string) {
  const out: Record<string, string>[] = [];
  for (const part of range.split(',').map((p) => p.trim())) {
    const match = /^(>=|<=|<)\s*(\S+)$/u.exec(part);
    if (!match) throw new Error(`unsupported synthetic range ${range}`);
    out.push({
      [{ '>=': 'introduced', '<': 'fixed', '<=': 'last_affected' }[match[1]]!]: match[2],
    });
  }
  return out.some((e) => 'introduced' in e) ? out : [{ introduced: '0' }, ...out];
}
function osvRecord(record: GithubRecord) {
  const severity = record.severity === 'medium' ? 'moderate' : record.severity;
  return {
    id: record.ghsa_id,
    summary: record.summary,
    ...(record.withdrawn_at ? { withdrawn: record.withdrawn_at } : {}),
    database_specific: {
      github_reviewed: true,
      ...(severity && severity !== 'unknown' ? { severity: severity.toUpperCase() } : {}),
    },
    affected: record.vulnerabilities.map((v) => ({
      package: {
        ecosystem: v.package.ecosystem === 'pip' ? 'PyPI' : v.package.ecosystem,
        name: v.package.name,
      },
      ranges: [{ type: 'ECOSYSTEM', events: events(v.vulnerable_version_range) }],
    })),
  };
}
/** The equivalent exact GitHub query URL a handler written before OSV expects. */
function githubEquivalent(name: string, version: string) {
  const url = new URL('https://api.github.com/advisories');
  url.search = new URLSearchParams({
    ecosystem: 'pip',
    affects: `${name}@${version}`,
    type: 'reviewed',
    per_page: '100',
  }).toString();
  return url.href;
}
/** A spelling already in its canonical form: the normalized PyPI name or lowercase action. */
function canonical(name: string) {
  return name === name.toLowerCase().replace(/[-_.]+/gu, '-');
}
/**
 * A discovery record that stores a package under its canonical name, so its versioned query names
 * that name, as it did before discovery could clear a target. It is never a finding.
 */
function storedAs(ecosystem: string, type: string, name: string) {
  return {
    ghsa_id: 'GHSA-0000-0000-0000',
    html_url: 'https://github.com/advisories/GHSA-0000-0000-0000',
    summary: 'Stored name form',
    type,
    severity: 'unknown',
    withdrawn_at: null,
    vulnerabilities: [{ package: { ecosystem, name }, vulnerable_version_range: '*' }],
  };
}
/**
 * An npm batch answered as GitHub would: every record any of its exact singleton queries returns,
 * each distinct record once. A failed singleton fails the batch.
 */
async function npmBatch(github: Handler, batch: URL, init: RequestInit) {
  const records = new Map<string, GithubRecord>();
  for (const target of batch.searchParams.get('affects')!.split(',')) {
    const url = new URL(batch);
    url.searchParams.set('affects', target);
    url.searchParams.set('per_page', '100');
    const answer = await github(url.href, init);
    if (answer.status !== 200) return answer;
    for (const record of (await answer.json()) as GithubRecord[])
      records.set(JSON.stringify(record), record);
  }
  return Response.json([...records.values()]);
}
export function viaAdvisoryHttp(
  github: Handler,
): (url: string, init: RequestInit) => Promise<Response> {
  // Spellings each query type has discovered; a pip or actions versioned query needs one first.
  const discovered = new Set<string>();
  const unexpected = (message: string) => Response.json({ message }, { status: 418 });
  return async (url, init) => {
    const u = new URL(url);
    if (u.origin === 'https://api.osv.dev') {
      const headers = new Headers(init.headers);
      if (
        u.pathname !== '/v1/query' ||
        u.search ||
        init.method !== 'POST' ||
        init.credentials !== 'omit' ||
        headers.has('authorization') ||
        headers.get('accept') !== 'application/json' ||
        headers.get('content-type') !== 'application/json' ||
        headers.has('x-github-api-version')
      )
        return unexpected('OSV takes only a credential-free JSON POST to /v1/query');
      const query = JSON.parse(String(init.body)) as {
        package: { ecosystem: string; name: string };
        version: string;
        page_token?: string;
      };
      if (query.package.ecosystem !== 'PyPI' || query.page_token !== undefined)
        return unexpected('unexpected OSV query');
      const answer = await github(githubEquivalent(query.package.name, query.version), {
        ...init,
        method: 'GET',
        body: undefined,
      });
      if (answer.status !== 200) return answer;
      const records = (await answer.json()) as GithubRecord[];
      return Response.json(records.length ? { vulns: records.map(osvRecord) } : {});
    }
    if (u.origin === 'https://api.github.com' && u.pathname === '/advisories') {
      const ecosystem = u.searchParams.get('ecosystem'),
        type = u.searchParams.get('type'),
        affects = u.searchParams.get('affects')!.split(',');
      if (u.searchParams.get('per_page') === '50' && ecosystem === 'npm')
        return npmBatch(github, u, init);
      if (u.searchParams.get('per_page') === '50') {
        for (const name of affects) discovered.add(JSON.stringify([ecosystem, type, name]));
        return Response.json(
          affects.filter(canonical).map((name) => storedAs(ecosystem!, type!, name)),
        );
      }
      if (ecosystem === 'pip' && type === 'reviewed')
        return unexpected('pip reviewed lookups go to OSV');
      if (
        (ecosystem === 'pip' || ecosystem === 'actions') &&
        !affects.every((t) =>
          discovered.has(JSON.stringify([ecosystem, type, t.slice(0, t.lastIndexOf('@'))])),
        )
      )
        return unexpected('versioned query without discovery');
    }
    return github(url, init);
  };
}
