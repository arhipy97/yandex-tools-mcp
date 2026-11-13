#!/usr/bin/env node

import { createRequire } from 'node:module';
import { domainToUnicode } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { fetchSerp, getCredentials, requestXml } from './client.mjs';
import { checkPositions, parseSerp } from './serp.mjs';

// Reported to MCP clients; read from package.json so it can't drift from releases.
const { version } = createRequire(import.meta.url)('../package.json');

function detectLanguage(text) {
  const cyrillicPattern = /[\u0400-\u04FF]/;
  if (cyrillicPattern.test(text)) {
    return 'ru';
  }
  return 'en';
}

function cleanText(text) {
  return text
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

// Yandex returns internationalized (Cyrillic .рф etc.) domains in their ASCII
// punycode form — `заречнев.рф` arrives as `xn--d1abiacj6ales3d1b.xn--p1ai`,
// which is gibberish to the model reading the results. Convert IDN hosts back to
// Unicode for DISPLAY. Only touches `xn--` hosts; anything else (and any decode
// failure) is returned verbatim.
function toDisplayHost(host) {
  if (!host || !/xn--/i.test(host)) return host;
  try {
    return domainToUnicode(host) || host;
  } catch {
    return host;
  }
}

// Display form of a full URL: swaps a punycode host for its Unicode form while
// leaving the scheme/path/query untouched, so the result stays a usable URL.
function toDisplayUrl(url) {
  try {
    const parsed = new URL(url);
    const display = toDisplayHost(parsed.hostname);
    if (display === parsed.hostname) return url;
    const idx = url.toLowerCase().indexOf(parsed.hostname);
    return idx === -1 ? url : url.slice(0, idx) + display + url.slice(idx + parsed.hostname.length);
  } catch {
    return url;
  }
}

function extractDomain(url) {
  try {
    const urlObj = new URL(url);
    return toDisplayHost(urlObj.hostname);
  } catch {
    const match = url.match(/^(?:https?:\/\/)?([^/?#]+)/i);
    return toDisplayHost(match?.[1] || '');
  }
}

function parseXMLResults(xmlData, includeImages = false) {
  const results = [];
  const groupMatches = xmlData.matchAll(/<group>([\s\S]*?)<\/group>/g);

  let position = 0;
  for (const groupMatch of groupMatches) {
    const groupContent = groupMatch?.[1];
    if (!groupContent) continue;

    const docMatch = groupContent.match(/<doc[^>]*>([\s\S]*?)<\/doc>/);
    const docContent = docMatch?.[1];
    if (!docContent) continue;

    const urlMatch = docContent.match(/<url>([^<]+)<\/url>/);
    if (!urlMatch?.[1]) continue;

    position++;
    const url = urlMatch[1];

    const titleMatch = docContent.match(/<title>(.*?)<\/title>/s);
    const title = titleMatch?.[1] ? cleanText(titleMatch[1]) : 'No title';

    const headlineMatch = docContent.match(/<headline>(.*?)<\/headline>/s);
    const headline = headlineMatch?.[1] ? cleanText(headlineMatch[1]) : undefined;

    const passages = [];
    const passagesMatch = docContent.match(/<passages>([\s\S]*?)<\/passages>/);
    if (passagesMatch?.[1]) {
      const passageMatches = passagesMatch[1].matchAll(/<passage>(.*?)<\/passage>/gs);
      for (const match of passageMatches) {
        if (match[1]) {
          passages.push(cleanText(match[1]));
        }
      }
    }

    const snippet = passages.length > 0 ? passages.join(' ') : headline || '';

    const sizeMatch = docContent.match(/<size>(\d+)<\/size>/);
    const size = sizeMatch?.[1] ? parseInt(sizeMatch[1], 10) : undefined;

    const langMatch = docContent.match(/<lang>([^<]+)<\/lang>/);
    const lang = langMatch?.[1] || undefined;

    const cachedUrlMatch = docContent.match(/<saved-copy-url>([^<]+)<\/saved-copy-url>/);
    const cachedUrl = cachedUrlMatch?.[1] || undefined;

    const result = {
      position,
      url: toDisplayUrl(url),
      domain: extractDomain(url),
      title,
      headline,
      passages: passages.length > 0 ? passages : undefined,
      snippet: snippet || 'No content available',
      size,
      lang,
      cachedUrl,
    };

    if (includeImages) {
      const imgMatch =
        groupContent.match(/<img[^>]*src="([^"]+)"/i) ||
        groupContent.match(/<image>([^<]+)<\/image>/i) ||
        groupContent.match(/<thumb>([^<]+)<\/thumb>/i);

      if (imgMatch?.[1]) {
        result.image = imgMatch[1];
      }
    }

    results.push(result);
  }

  return results;
}

const REGION_NAMES = { 157: 'Минск', 213: 'Москва' };

function formatRow(row, depthDefault) {
  const region = REGION_NAMES[row.region] ?? String(row.region);
  const head = `${row.phrase} · ${region}`;
  if (row.status === 'found') return `${head} · ${row.position} · ${row.url}`;
  if (row.status === 'not_found') return `${head} · вне топ-${row.checked ?? depthDefault}`;
  return `${head} · ошибка: ${row.error}`;
}

async function search(query, options = {}) {
  const { apiKey, folderId } = getCredentials();
  const maxResults = options.maxResults || 10;
  const includeImages = options.includeImages ?? false;

  const language = detectLanguage(query);

  const searchTypeMap = {
    ru: 'SEARCH_TYPE_RU',
    be: 'SEARCH_TYPE_BE',
    uk: 'SEARCH_TYPE_UK',
    kk: 'SEARCH_TYPE_KK',
    en: 'SEARCH_TYPE_COM',
  };

  const l10nMap = {
    ru: 'LOCALIZATION_RU',
    be: 'LOCALIZATION_BE',
    uk: 'LOCALIZATION_UK',
    kk: 'LOCALIZATION_KK',
    en: 'LOCALIZATION_EN',
  };

  const searchType = searchTypeMap[language] || 'SEARCH_TYPE_RU';
  const l10n = l10nMap[language] || 'LOCALIZATION_RU';

  const requestBody = {
    query: {
      searchType: options.searchType || searchType,
      queryText: query,
      familyMode: options.familyMode || 'FAMILY_MODE_MODERATE',
      page: String(options.page || 0),
      fixTypoMode: 'FIX_TYPO_MODE_ON',
    },
    sortSpec: {
      sortMode: options.sortMode || 'SORT_MODE_BY_RELEVANCE',
      sortOrder: 'SORT_ORDER_DESC',
    },
    groupSpec: {
      groupMode: 'GROUP_MODE_DEEP',
      groupsOnPage: String(maxResults),
      docsInGroup: '1',
    },
    folderId,
    responseFormat: 'FORMAT_XML',
    l10n,
  };

  if (options.region) {
    requestBody.region = String(options.region);
  }

  const xmlData = await requestXml(requestBody, apiKey);
  const serp = parseSerp(xmlData);
  // Yandex error 15 means "nothing found": keep upstream behaviour (empty list) for search.
  if (serp.error?.startsWith('yandex ') && !serp.error.startsWith('yandex 15:')) throw new Error(serp.error);
  const results = parseXMLResults(xmlData, includeImages);

  return results.slice(0, maxResults);
}

const server = new McpServer({
  name: 'yandex-search',
  version,
});

server.registerTool(
  'search',
  {
    title: 'Yandex Search',
    annotations: { readOnlyHint: true },
    description:
      'Search the web using Yandex. Optimized for Russian and Cyrillic content but works for any language. Returns structured results with position, url, domain, title, headline (meta description), passages (text snippets array), snippet (combined text), size, lang, and cachedUrl.',
    inputSchema: {
      query: z.string().describe('Search query'),
      maxResults: z.number().min(1).max(10).optional().describe('Maximum number of results (default: 10, max: 10)'),
      includeImages: z.boolean().optional().describe('Include image URLs in results (default: false)'),
      region: z.number().optional().describe('Region ID for localized results (e.g., 213 for Moscow)'),
      page: z.number().min(0).optional().describe('Page number for pagination (default: 0)'),
      familyMode: z
        .enum(['FAMILY_MODE_NONE', 'FAMILY_MODE_MODERATE', 'FAMILY_MODE_STRICT'])
        .optional()
        .describe('Content filtering level (default: FAMILY_MODE_MODERATE)'),
    },
  },
  async ({ query, maxResults, includeImages, region, page, familyMode }) => {
    const results = await search(query, {
      maxResults,
      includeImages,
      region,
      page,
      familyMode,
    });

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ query, totalResults: results.length, results }, null, 2),
        },
      ],
    };
  },
);

server.registerTool(
  'positions',
  {
    title: 'Yandex Positions',
    description:
      'Check where a site ranks in Yandex web search for each phrase and region. Returns one line per phrase and region pair: position, or "вне топ-N" when not found in the checked results. Regions: 157 Минск, 213 Москва. Requests run one at a time (Search API quota is 1 per second), about 1 s per pair; a quota error is retried once.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      phrases: z.array(z.string().min(1)).min(1).max(20).describe('Search phrases (1 to 20)'),
      regions: z.array(z.number()).min(1).optional().describe('Yandex region IDs (default: [157, 213])'),
      domain: z.string().min(1).optional().describe('Site domain to look for (default: fluffme.design)'),
      depth: z.number().int().min(1).max(100).optional().describe('How many results to check (default: 40)'),
    },
  },
  async ({ phrases, regions, domain, depth }) => {
    const rows = await checkPositions({ phrases, regions, domain, depth }, fetchSerp);
    return { content: [{ type: 'text', text: rows.map((r) => formatRow(r, depth ?? 40)).join('\n') }] };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('Yandex Search MCP server running on stdio');
