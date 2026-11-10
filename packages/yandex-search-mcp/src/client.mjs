import { parseSerp } from './serp.mjs';

const BASE_URL = 'https://searchapi.api.cloud.yandex.net/v2/web/search';

export function getCredentials(env = process.env) {
  const apiKey = env.YANDEX_SEARCH_API_KEY;
  const folderId = env.YANDEX_FOLDER_ID;

  if (!apiKey) {
    throw new Error('YANDEX_SEARCH_API_KEY environment variable is required. Get it from Yandex Cloud console.');
  }
  if (!folderId) {
    throw new Error('YANDEX_FOLDER_ID environment variable is required. Get it from Yandex Cloud console.');
  }

  return { apiKey, folderId };
}

const REQUEST_TIMEOUT_MS = 15000;

// POSTs a Search API request and returns the decoded XML; throws on HTTP errors
// and on a response without rawData.
export async function requestXml(requestBody, apiKey, fetchImpl = fetch) {
  const response = await fetchImpl(BASE_URL, {
    method: 'POST',
    headers: {
      Authorization: `Api-Key ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(requestBody),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    const errorText = await response.text();
    let errorMessage = `Yandex Search API error (${response.status}): ${response.statusText}`;
    try {
      const errorJson = JSON.parse(errorText);
      if (errorJson.message) {
        errorMessage = errorJson.message;
      }
    } catch {
      if (errorText) {
        errorMessage = errorText;
      }
    }
    throw new Error(errorMessage);
  }

  const data = await response.json();
  if (typeof data.rawData !== 'string') {
    throw new Error('Yandex Search API response has no rawData');
  }
  return Buffer.from(data.rawData, 'base64').toString('utf-8');
}

// Compact ru-web SERP for rank checks; never throws, errors come back as `error`.
export async function fetchSerp(query, region, depth, { fetchImpl = fetch, env = process.env } = {}) {
  try {
    const { apiKey, folderId } = getCredentials(env);
    const xml = await requestXml(
      {
        query: {
          searchType: 'SEARCH_TYPE_RU',
          queryText: query,
          familyMode: 'FAMILY_MODE_MODERATE',
          page: '0',
          fixTypoMode: 'FIX_TYPO_MODE_ON',
        },
        sortSpec: { sortMode: 'SORT_MODE_BY_RELEVANCE', sortOrder: 'SORT_ORDER_DESC' },
        groupSpec: { groupMode: 'GROUP_MODE_DEEP', groupsOnPage: String(depth), docsInGroup: '1' },
        folderId,
        responseFormat: 'FORMAT_XML',
        l10n: 'LOCALIZATION_RU',
        region: String(region),
      },
      apiKey,
      fetchImpl,
    );
    return parseSerp(xml);
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e), results: [] };
  }
}
