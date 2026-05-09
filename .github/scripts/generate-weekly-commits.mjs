import { writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const login = process.env.PROFILE_LOGIN || "Birditch";
const token = process.env.PROFILE_STATS_TOKEN || process.env.METRICS_TOKEN || process.env.GITHUB_TOKEN;
const output = process.env.WEEKLY_COMMITS_OUTPUT || "assets/weekly-commits.svg";
const execFileAsync = promisify(execFile);

const headers = token ? {
  Accept: "application/vnd.github+json",
  Authorization: `Bearer ${token}`,
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "Birditch-profile-assets",
} : null;

function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

function dayLabel(date) {
  return new Intl.DateTimeFormat("en", {
    timeZone: "UTC",
    weekday: "short",
  }).format(date);
}

async function countCommitsForDay(date) {
  const day = formatDate(date);
  const q = `author:${login} author-date:${day}..${day}`;
  const url = new URL("https://api.github.com/search/commits");
  url.searchParams.set("q", q);
  url.searchParams.set("per_page", "1");

  let data;
  if (headers) {
    const response = await fetch(url, { headers });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`GitHub commit search failed for ${day}: ${response.status} ${body}`);
    }
    data = await response.json();
  } else {
    // 本地运行时优先复用 gh 的认证存储，避免把 token 打印到 shell 或日志中。
    const { stdout } = await execFileAsync("gh", [
      "api",
      url.toString(),
      "-H",
      "Accept: application/vnd.github+json",
    ], { maxBuffer: 1024 * 1024 });
    data = JSON.parse(stdout);
  }

  return {
    day,
    label: dayLabel(date),
    count: Number(data.total_count || 0),
    incomplete: Boolean(data.incomplete_results),
  };
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function buildSvg(days) {
  const total = days.reduce((sum, day) => sum + day.count, 0);
  const max = Math.max(1, ...days.map((day) => day.count));
  const incomplete = days.some((day) => day.incomplete);
  const updated = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date());

  const bars = days
    .map((day, index) => {
      const x = 330 + index * 74;
      const barHeight = Math.max(10, Math.round((day.count / max) * 92));
      const y = 146 - barHeight;
      const color = day.count === 0 ? "#30363d" : index === days.length - 1 ? "#f0b72f" : "#58a6ff";
      return `
        <g>
          <rect x="${x}" y="${y}" width="48" height="${barHeight}" rx="8" fill="${color}"/>
          <text x="${x + 24}" y="${y - 10}" text-anchor="middle" fill="#c9d1d9" font-size="14" font-weight="800">${day.count}</text>
          <text x="${x + 24}" y="172" text-anchor="middle" fill="#8b949e" font-size="12" font-weight="700">${escapeXml(day.label)}</text>
          <text x="${x + 24}" y="190" text-anchor="middle" fill="#8b949e" font-size="11">${escapeXml(day.day.slice(5))}</text>
        </g>`;
    })
    .join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="210" viewBox="0 0 960 210" role="img" aria-labelledby="title desc">
  <title id="title">近7天提交次数</title>
  <desc id="desc">Birditch 最近 7 天 Git commit 数量，总计 ${total} 次。私有仓库会在 token 有权限时计入。</desc>
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#0d1117"/>
      <stop offset="1" stop-color="#161b22"/>
    </linearGradient>
  </defs>
  <rect width="960" height="210" rx="18" fill="url(#bg)" stroke="#30363d"/>
  <g font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Arial,sans-serif">
    <text x="42" y="48" fill="#ffffff" font-size="24" font-weight="800">近7天提交次数</text>
    <text x="42" y="76" fill="#8b949e" font-size="14">包含当前 token 可访问的公开与私有仓库，不展示私有仓库名称。</text>
    <text x="42" y="136" fill="#58a6ff" font-size="64" font-weight="900">${total}</text>
    <text x="44" y="166" fill="#8b949e" font-size="13">${escapeXml(incomplete ? "GitHub 搜索结果可能未完全返回" : `更新时间 ${updated} New York`)}</text>${bars}
  </g>
</svg>
`;
}

const now = new Date();
const todayUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
const days = [];
for (let offset = 6; offset >= 0; offset -= 1) {
  const date = new Date(todayUtc);
  date.setUTCDate(todayUtc.getUTCDate() - offset);
  days.push(await countCommitsForDay(date));
}

await writeFile(output, buildSvg(days), "utf8");
console.log(`Generated ${output}`);
