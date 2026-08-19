/**
 * 项目更新检查：查询 GitHub Releases 最新版本。
 *
 * 纯浏览器 fetch 实现（无 chrome.* 依赖），MV3 扩展页 CSP 未限制 connect-src，外部 fetch 允许。
 * zip 下载由调用方用原生 <a download> 触发浏览器下载，不经 JS fetch（避免重定向 CORS 问题）。
 * GitHub API 未认证限流为 60 次/小时/IP，个人使用足够。
 */

import { logger } from '../lib/logger.js';
import { BusinessError, ERROR_CODE } from '../lib/errors.js';
import { compareVersions, normalizeVersion } from '../lib/semver.js';
import { CURRENT_EXTENSION_VERSION } from '../lib/release-notes.js';

/** GitHub 仓库（owner/repo） */
export const UPDATE_GITHUB_REPO = 'FaustDream/cloudpiovt-plugin';

/** GitHub API 请求超时 */
const REQUEST_TIMEOUT_MS = 10_000;

/** 最新 release 信息 */
export interface LatestReleaseInfo {
  readonly tagName: string;
  readonly version: string;
  readonly htmlUrl: string;
  readonly publishedAt: string;
  readonly zipUrl: string | null;
  readonly zipName: string | null;
}

/** GitHub Release 资产（原始 JSON 项，需运行时校验） */
interface RawReleaseAsset {
  readonly name?: unknown;
  readonly browser_download_url?: unknown;
}

function isRawReleaseAsset(v: unknown): v is RawReleaseAsset {
  if (typeof v !== 'object' || v === null) return false;
  const asset = v as Record<string, unknown>;
  return typeof asset.name === 'string' && typeof asset.browser_download_url === 'string';
}

/** 从 release 原始 JSON 中解析资产，返回第一个 zip 的下载信息 */
function pickZipAsset(assets: unknown): { name: string; url: string } | null {
  if (!Array.isArray(assets)) return null;
  for (const raw of assets) {
    if (!isRawReleaseAsset(raw)) continue;
    const name = raw.name as string;
    const url = raw.browser_download_url as string;
    if (name.toLowerCase().endsWith('.zip') && url.startsWith('https://')) {
      return { name, url };
    }
  }
  return null;
}

/** 校验并解析 release 原始 JSON */
function parseLatestRelease(raw: unknown): LatestReleaseInfo {
  if (typeof raw !== 'object' || raw === null) {
    throw new BusinessError(ERROR_CODE.INVALID_INPUT, 'GitHub 返回的数据格式不正确');
  }
  const data = raw as Record<string, unknown>;
  if (typeof data.tag_name !== 'string' || !data.tag_name) {
    throw new BusinessError(ERROR_CODE.INVALID_INPUT, 'GitHub 返回缺少 tag_name');
  }
  const tagName = data.tag_name;
  const htmlUrl = typeof data.html_url === 'string' ? data.html_url : `https://github.com/${UPDATE_GITHUB_REPO}/releases/tag/${tagName}`;
  const publishedAt = typeof data.published_at === 'string' ? data.published_at : '';
  const zip = pickZipAsset(data.assets);
  return {
    tagName,
    version: normalizeVersion(tagName),
    htmlUrl,
    publishedAt,
    zipUrl: zip?.url ?? null,
    zipName: zip?.name ?? null,
  };
}

/** 查询 GitHub Releases 最新版（正式版） */
export async function fetchLatestRelease(): Promise<LatestReleaseInfo> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`https://api.github.com/repos/${UPDATE_GITHUB_REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json' },
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new BusinessError(ERROR_CODE.UNKNOWN, `GitHub 请求失败（HTTP ${res.status}）`, {
        status: res.status,
      });
    }
    const info = parseLatestRelease(await res.json());
    logger.info('Fetched latest release', { tagName: info.tagName, version: info.version });
    return info;
  } catch (err: unknown) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new BusinessError(ERROR_CODE.TIMEOUT, '检查更新超时，请稍后重试');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** 当前版本是否已是最新（无需更新返回 true） */
export function isUpToDate(latest: LatestReleaseInfo): boolean {
  return compareVersions(latest.version, CURRENT_EXTENSION_VERSION) <= 0;
}

/** 判断最新版是否比当前版本更新 */
export function hasNewerVersion(latest: LatestReleaseInfo): boolean {
  return compareVersions(latest.version, CURRENT_EXTENSION_VERSION) > 0;
}
