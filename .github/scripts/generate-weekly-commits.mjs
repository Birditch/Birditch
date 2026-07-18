import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";

const login = process.env.PROFILE_LOGIN || "Birditch";
const token =
  process.env.PROFILE_STATS_TOKEN ||
  process.env.METRICS_TOKEN ||
  process.env.GITHUB_TOKEN;
const weeklyOutput =
  process.env.WEEKLY_COMMITS_OUTPUT || "assets/weekly-commits.svg";
const contributionsOutput =
  process.env.CONTRIBUTIONS_OUTPUT || "assets/contribution-calendar.svg";
const execFileAsync = promisify(execFile);

const headers = token
  ? {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "Birditch-profile-assets",
    }
  : null;

function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

function dayLabel(date) {
  return new Intl.DateTimeFormat("en", {
    timeZone: "UTC",
    weekday: "short",
  }).format(date);
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function writeSvg(path, contents) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents, "utf8");
  console.log(`Generated ${path}`);
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
      throw new Error(
        `GitHub commit search failed for ${day}: ${response.status} ${body}`,
      );
    }
    data = await response.json();
  } else {
    // Local runs reuse gh authentication without exposing its token in the shell.
    const { stdout } = await execFileAsync(
      "gh",
      [
        "api",
        url.toString(),
        "-H",
        "Accept: application/vnd.github+json",
      ],
      { maxBuffer: 1024 * 1024 },
    );
    data = JSON.parse(stdout);
  }

  return {
    day,
    label: dayLabel(date),
    count: Number(data.total_count || 0),
    incomplete: Boolean(data.incomplete_results),
  };
}

async function fetchContributionCalendar(from, to) {
  const query = `
    query ProfileContributions($login: String!, $from: DateTime!, $to: DateTime!) {
      user(login: $login) {
        contributionsCollection(from: $from, to: $to) {
          restrictedContributionsCount
          contributionCalendar {
            totalContributions
            weeks {
              contributionDays {
                contributionCount
                date
                weekday
              }
            }
          }
        }
      }
    }
  `;

  let data;
  if (headers) {
    const response = await fetch("https://api.github.com/graphql", {
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query,
        variables: { login, from: from.toISOString(), to: to.toISOString() },
      }),
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `GitHub contributions query failed: ${response.status} ${body}`,
      );
    }
    data = await response.json();
  } else {
    const { stdout } = await execFileAsync(
      "gh",
      [
        "api",
        "graphql",
        "-f",
        `query=${query}`,
        "-F",
        `login=${login}`,
        "-F",
        `from=${from.toISOString()}`,
        "-F",
        `to=${to.toISOString()}`,
      ],
      { maxBuffer: 4 * 1024 * 1024 },
    );
    data = JSON.parse(stdout);
  }

  if (data.errors?.length) {
    throw new Error(
      `GitHub contributions query failed: ${JSON.stringify(data.errors)}`,
    );
  }

  const collection = data.data?.user?.contributionsCollection;
  if (!collection?.contributionCalendar) {
    throw new Error(`GitHub user not found: ${login}`);
  }

  return {
    ...collection.contributionCalendar,
    restrictedContributionsCount: Number(
      collection.restrictedContributionsCount || 0,
    ),
  };
}

function buildWeeklySvg(days) {
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
      const color =
        day.count === 0
          ? "#30363d"
          : index === days.length - 1
            ? "#f0b72f"
            : "#58a6ff";
      return `
        <g>
          <rect x="${x}" y="${y}" width="48" height="${barHeight}" rx="6" fill="${color}"/>
          <text x="${x + 24}" y="${y - 10}" text-anchor="middle" fill="#c9d1d9" font-size="14" font-weight="800">${day.count}</text>
          <text x="${x + 24}" y="172" text-anchor="middle" fill="#8b949e" font-size="12" font-weight="700">${escapeXml(day.label)}</text>
          <text x="${x + 24}" y="190" text-anchor="middle" fill="#8b949e" font-size="11">${escapeXml(day.day.slice(5))}</text>
        </g>`;
    })
    .join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="210" viewBox="0 0 960 210" role="img" aria-labelledby="title desc">
  <title id="title">近7天提交次数</title>
  <desc id="desc">Birditch 最近 7 天 Git commit 数量，总计 ${total} 次。私有仓库会在 token 有权限时计入。</desc>
  <rect width="960" height="210" rx="8" fill="#0d1117" stroke="#30363d"/>
  <path d="M0 1 H960" stroke="#58a6ff" stroke-width="3"/>
  <g font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Arial,sans-serif">
    <text x="42" y="48" fill="#ffffff" font-size="24" font-weight="800">近7天提交次数</text>
    <text x="42" y="76" fill="#8b949e" font-size="14">公开与授权可见的私有仓库，仅汇总数量。</text>
    <text x="42" y="136" fill="#58a6ff" font-size="64" font-weight="900">${total}</text>
    <text x="44" y="166" fill="#8b949e" font-size="13">${escapeXml(incomplete ? "GitHub 搜索结果可能未完全返回" : `更新于 ${updated} · New York`)}</text>${bars}
  </g>
</svg>
`;
}

function contributionLevel(count, max) {
  if (count === 0) return 0;
  const ratio = count / Math.max(1, max);
  if (ratio <= 0.12) return 1;
  if (ratio <= 0.3) return 2;
  if (ratio <= 0.58) return 3;
  return 4;
}

function calculateStreaks(days) {
  const ordered = [...days].sort((a, b) => a.date.localeCompare(b.date));
  let longest = 0;
  let running = 0;
  for (const day of ordered) {
    if (day.contributionCount > 0) {
      running += 1;
      longest = Math.max(longest, running);
    } else {
      running = 0;
    }
  }

  const currentDays = [...ordered];
  if (currentDays.at(-1)?.contributionCount === 0) currentDays.pop();
  let current = 0;
  for (let index = currentDays.length - 1; index >= 0; index -= 1) {
    if (currentDays[index].contributionCount === 0) break;
    current += 1;
  }

  return { current, longest };
}

function buildContributionSvg(calendar) {
  const weeks = calendar.weeks;
  const days = weeks.flatMap((week) => week.contributionDays);
  const max = Math.max(1, ...days.map((day) => day.contributionCount));
  const activeDays = days.filter((day) => day.contributionCount > 0).length;
  const { current, longest } = calculateStreaks(days);
  const palette = ["#161b22", "#0e4429", "#006d32", "#26a641", "#39d353"];

  const monthLabels = [];
  let previousMonth = -1;
  for (let weekIndex = 0; weekIndex < weeks.length; weekIndex += 1) {
    const firstDay = weeks[weekIndex].contributionDays[0];
    if (!firstDay) continue;
    const month = new Date(`${firstDay.date}T00:00:00Z`).getUTCMonth();
    if (month === previousMonth) continue;
    previousMonth = month;
    const label = new Intl.DateTimeFormat("en", {
      timeZone: "UTC",
      month: "short",
    }).format(new Date(`${firstDay.date}T00:00:00Z`));
    monthLabels.push(
      `<text x="${190 + weekIndex * 13}" y="91" fill="#8b949e" font-size="11">${label}</text>`,
    );
  }

  const cells = weeks
    .flatMap((week, weekIndex) =>
      week.contributionDays.map((day) => {
        const level = contributionLevel(day.contributionCount, max);
        const x = 190 + weekIndex * 13;
        const y = 101 + day.weekday * 13;
        return `<rect x="${x}" y="${y}" width="10" height="10" rx="2" fill="${palette[level]}"><title>${escapeXml(day.date)}: ${day.contributionCount} contributions</title></rect>`;
      }),
    )
    .join("");

  const restricted =
    calendar.restrictedContributionsCount > 0
      ? ` · 含 ${calendar.restrictedContributionsCount} 次私有贡献`
      : "";

  return `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="260" viewBox="0 0 960 260" role="img" aria-labelledby="title desc">
  <title id="title">近一年贡献热力图</title>
  <desc id="desc">Birditch 近一年共 ${calendar.totalContributions} 次贡献，活跃 ${activeDays} 天，当前连续 ${current} 天。</desc>
  <rect width="960" height="260" rx="8" fill="#0d1117" stroke="#30363d"/>
  <path d="M0 1 H960" stroke="#2ea043" stroke-width="3"/>
  <g font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Arial,sans-serif">
    <text x="42" y="45" fill="#ffffff" font-size="24" font-weight="800">近一年贡献活动</text>
    <text x="42" y="70" fill="#8b949e" font-size="13">${calendar.totalContributions} 次贡献 · ${activeDays} 个活跃日${restricted}</text>
    ${monthLabels.join("")}
    <text x="144" y="122" fill="#8b949e" font-size="11">Mon</text>
    <text x="144" y="148" fill="#8b949e" font-size="11">Wed</text>
    <text x="144" y="174" fill="#8b949e" font-size="11">Fri</text>
    ${cells}
    <path d="M42 207 H918" stroke="#21262d"/>
    <text x="42" y="235" fill="#8b949e" font-size="12">CURRENT STREAK</text>
    <text x="174" y="235" fill="#58a6ff" font-size="18" font-weight="800">${current} days</text>
    <text x="344" y="235" fill="#8b949e" font-size="12">LONGEST</text>
    <text x="424" y="235" fill="#f0b72f" font-size="18" font-weight="800">${longest} days</text>
    <text x="570" y="235" fill="#8b949e" font-size="12">PEAK DAY</text>
    <text x="652" y="235" fill="#39d353" font-size="18" font-weight="800">${max}</text>
    <text x="805" y="235" fill="#8b949e" font-size="11">less</text>
    ${palette.map((color, index) => `<rect x="${838 + index * 14}" y="225" width="10" height="10" rx="2" fill="${color}"/>`).join("")}
    <text x="910" y="235" fill="#8b949e" font-size="11">more</text>
  </g>
</svg>
`;
}

const now = new Date();
const todayUtc = new Date(
  Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
);
const weeklyDays = [];
for (let offset = 6; offset >= 0; offset -= 1) {
  const date = new Date(todayUtc);
  date.setUTCDate(todayUtc.getUTCDate() - offset);
  weeklyDays.push(await countCommitsForDay(date));
}

const calendarTo = new Date(todayUtc);
calendarTo.setUTCHours(23, 59, 59, 999);
const calendarFrom = new Date(calendarTo);
calendarFrom.setUTCDate(calendarTo.getUTCDate() - 364);
calendarFrom.setUTCHours(0, 0, 0, 0);
const calendar = await fetchContributionCalendar(calendarFrom, calendarTo);

await Promise.all([
  writeSvg(weeklyOutput, buildWeeklySvg(weeklyDays)),
  writeSvg(contributionsOutput, buildContributionSvg(calendar)),
]);
