import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createS3Client,
  TRASH_PREFIX,
  TRASH_LIFECYCLE_RULE_ID,
  TRASH_LIFECYCLE_EXPIRATION_DAYS,
} from '../src/s3';

const creds = { accessKeyId: 'key', secretAccessKey: 'secret' };
const endpoint = 'https://account.r2.cloudflarestorage.com';
const bucket = 'client-bucket';

const NO_SUCH_LIFECYCLE_BODY =
  '<?xml version="1.0" encoding="UTF-8"?><Error><Code>NoSuchLifecycleConfiguration</Code>' +
  '<Message>The lifecycle configuration does not exist</Message></Error>';

const MULTIPART_ABORT_RULE =
  '<Rule><ID>Default Multipart Abort Rule</ID><Filter><Prefix></Prefix></Filter>' +
  '<Status>Enabled</Status><AbortIncompleteMultipartUpload><DaysAfterInitiation>7</DaysAfterInitiation>' +
  '</AbortIncompleteMultipartUpload></Rule>';

// A foreign rule using fields this client does not model at all
// (Transition to Infrequent Access) — it must survive byte-for-byte.
const TRANSITION_TO_IA_RULE =
  '<Rule><ID>client-archive-rule</ID><Filter><Prefix>archive/</Prefix></Filter>' +
  '<Status>Enabled</Status><Transition><Days>90</Days><StorageClass>STANDARD_IA</StorageClass></Transition></Rule>';

function lifecycleXml(ruleBlocks: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>` +
    `<LifecycleConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">` +
    ruleBlocks.join('') +
    `</LifecycleConfiguration>`;
}

function extractRuleIds(xml: string): string[] {
  const ids: string[] = [];
  const re = /<ID>([^<]*)<\/ID>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) ids.push(m[1]);
  return ids;
}

describe('s3 trash lifecycle rule', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let getResponses: (Response | (() => Response))[];

  beforeEach(() => {
    getResponses = [];
    fetchMock = vi.fn(async (req: Request) => {
      const url = new URL(req.url);
      if (req.method === 'PUT') {
        const bodyText = await req.clone().text();
        return new Response(bodyText, { status: 200 });
      }
      // GET
      expect(url.search).toBe('?lifecycle');
      const next = getResponses.shift();
      if (!next) throw new Error('no more mocked GET responses queued');
      return typeof next === 'function' ? next() : next;
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('creates a fresh configuration with just our rule when the bucket has none', async () => {
    getResponses.push(new Response(NO_SUCH_LIFECYCLE_BODY, { status: 404 }));

    const s3 = createS3Client(creds, endpoint);
    await s3.s3ApplyTrashLifecycleRule(bucket);

    expect(fetchMock).toHaveBeenCalledTimes(2); // GET then PUT
    const putReq = fetchMock.mock.calls[1][0] as Request;
    expect(putReq.method).toBe('PUT');
    const putBody = await putReq.clone().text();

    expect(extractRuleIds(putBody)).toEqual([TRASH_LIFECYCLE_RULE_ID]);
    expect(putBody).toContain(`<Prefix>${TRASH_PREFIX}</Prefix>`);
    expect(putBody).toContain(`<Days>${TRASH_LIFECYCLE_EXPIRATION_DAYS}</Days>`);
  });

  it('preserves unrelated existing rules, including ones with fields it does not model', async () => {
    getResponses.push(
      new Response(lifecycleXml([MULTIPART_ABORT_RULE, TRANSITION_TO_IA_RULE]), { status: 200 }),
    );

    const s3 = createS3Client(creds, endpoint);
    await s3.s3ApplyTrashLifecycleRule(bucket);

    const putReq = fetchMock.mock.calls[1][0] as Request;
    const putBody = await putReq.clone().text();

    // Foreign rules are carried through byte-for-byte.
    expect(putBody).toContain(MULTIPART_ABORT_RULE);
    expect(putBody).toContain(TRANSITION_TO_IA_RULE);

    // Plus exactly one copy of our own rule.
    expect(extractRuleIds(putBody).sort()).toEqual(
      ['Default Multipart Abort Rule', 'client-archive-rule', TRASH_LIFECYCLE_RULE_ID].sort(),
    );
  });

  it('is idempotent: applying twice leaves exactly one of our rules, foreign rules intact', async () => {
    // First GET: only the foreign multipart-abort rule exists.
    getResponses.push(new Response(lifecycleXml([MULTIPART_ABORT_RULE]), { status: 200 }));

    const s3 = createS3Client(creds, endpoint);
    await s3.s3ApplyTrashLifecycleRule(bucket);

    const firstPutReq = fetchMock.mock.calls[1][0] as Request;
    const firstPutBody = await firstPutReq.clone().text();

    // Second GET: what the bucket now holds after the first PUT.
    getResponses.push(new Response(firstPutBody, { status: 200 }));

    await s3.s3ApplyTrashLifecycleRule(bucket);

    expect(fetchMock).toHaveBeenCalledTimes(4); // GET, PUT, GET, PUT
    const secondPutReq = fetchMock.mock.calls[3][0] as Request;
    const secondPutBody = await secondPutReq.clone().text();

    const ids = extractRuleIds(secondPutBody);
    expect(ids.filter(id => id === TRASH_LIFECYCLE_RULE_ID)).toHaveLength(1);
    expect(secondPutBody).toContain(MULTIPART_ABORT_RULE);
  });

  it('writes an expiration rule scoped to the exact trash prefix, never a bucket-wide rule', async () => {
    getResponses.push(new Response(NO_SUCH_LIFECYCLE_BODY, { status: 404 }));

    const s3 = createS3Client(creds, endpoint);
    await s3.s3ApplyTrashLifecycleRule(bucket);

    const putReq = fetchMock.mock.calls[1][0] as Request;
    const putBody = await putReq.clone().text();

    expect(TRASH_PREFIX.length).toBeGreaterThan(0);
    expect(putBody).not.toMatch(/<Prefix>\s*<\/Prefix>[\s\S]*?<Expiration>/);
    expect(putBody).toContain(`<ID>${TRASH_LIFECYCLE_RULE_ID}</ID><Filter><Prefix>${TRASH_PREFIX}</Prefix>`);
  });

  it('refuses to rewrite the configuration if an existing rule cannot be parsed faithfully', async () => {
    // A <Rule with attributes> is not the plain <Rule> shape this client
    // knows how to carry through untouched — it must fail closed rather
    // than silently drop it.
    const unparseable = lifecycleXml([]).replace(
      '</LifecycleConfiguration>',
      '<Rule xmlns:x="weird"><ID>odd</ID></Rule></LifecycleConfiguration>',
    );
    getResponses.push(new Response(unparseable, { status: 200 }));

    const s3 = createS3Client(creds, endpoint);
    await expect(s3.s3ApplyTrashLifecycleRule(bucket)).rejects.toThrow();

    // Only the GET happened — no PUT was attempted with a mutilated config.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
