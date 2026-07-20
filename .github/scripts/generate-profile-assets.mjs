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
const githubBadgeOutput =
  process.env.GITHUB_BADGE_OUTPUT || "assets/profile-github.svg";
const followersBadgeOutput =
  process.env.FOLLOWERS_BADGE_OUTPUT || "assets/profile-followers.svg";
const timezoneBadgeOutput =
  process.env.TIMEZONE_BADGE_OUTPUT || "assets/profile-timezone.svg";
const languageUsageOutput =
  process.env.LANGUAGE_USAGE_OUTPUT || "assets/language-usage.svg";
const organizationOverviewOutput =
  process.env.ORGANIZATION_OVERVIEW_OUTPUT ||
  "assets/organization-overview.svg";
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

async function githubGraphql(query, variables = {}) {
  let data;
  if (headers) {
    const response = await fetch("https://api.github.com/graphql", {
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `GitHub GraphQL query failed: ${response.status} ${body}`,
      );
    }
    data = await response.json();
  } else {
    const args = ["api", "graphql", "-f", `query=${query}`];
    for (const [name, value] of Object.entries(variables)) {
      if (value !== null && value !== undefined) {
        args.push("-F", `${name}=${value}`);
      }
    }
    const { stdout } = await execFileAsync("gh", args, {
      maxBuffer: 16 * 1024 * 1024,
    });
    data = JSON.parse(stdout);
  }

  if (data.errors?.length) {
    throw new Error(`GitHub GraphQL query failed: ${JSON.stringify(data.errors)}`);
  }
  return data.data;
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

  const data = await githubGraphql(query, {
    login,
    from: from.toISOString(),
    to: to.toISOString(),
  });
  const collection = data.user?.contributionsCollection;
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

async function fetchUserProfile() {
  const url = `https://api.github.com/users/${encodeURIComponent(login)}`;
  let data;

  if (headers) {
    const response = await fetch(url, { headers });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `GitHub profile query failed: ${response.status} ${body}`,
      );
    }
    data = await response.json();
  } else {
    const { stdout } = await execFileAsync("gh", ["api", `users/${login}`], {
      maxBuffer: 1024 * 1024,
    });
    data = JSON.parse(stdout);
  }

  return {
    login: data.login || login,
    followers: Number(data.followers || 0),
  };
}

async function fetchOrganizations() {
  const query = `
    query ProfileOrganizations($after: String) {
      viewer {
        organizations(first: 100, after: $after) {
          pageInfo {
            hasNextPage
            endCursor
          }
          nodes {
            login
            name
            repositories(
              first: 1
              orderBy: { field: PUSHED_AT, direction: DESC }
            ) {
              totalCount
              nodes {
                pushedAt
              }
            }
          }
        }
      }
    }
  `;

  const organizations = [];
  let after = null;
  do {
    const data = await githubGraphql(query, { after });
    const connection = data.viewer?.organizations;
    if (!connection) throw new Error("GitHub organization data is unavailable");
    organizations.push(
      ...connection.nodes.map((organization) => ({
        login: organization.login,
        name: organization.name || organization.login,
        repositoryCount: Number(organization.repositories.totalCount || 0),
        lastPushedAt: organization.repositories.nodes[0]?.pushedAt || null,
      })),
    );
    after = connection.pageInfo.hasNextPage
      ? connection.pageInfo.endCursor
      : null;
  } while (after);

  return organizations.sort((left, right) =>
    String(right.lastPushedAt || "").localeCompare(
      String(left.lastPushedAt || ""),
    ),
  );
}

async function fetchRepositoryLanguageStats(organizations) {
  const query = `
    query ProfileRepositories($after: String) {
      viewer {
        login
        repositoriesContributedTo(
          first: 100
          after: $after
          includeUserRepositories: true
          contributionTypes: [COMMIT, PULL_REQUEST, PULL_REQUEST_REVIEW, REPOSITORY]
          orderBy: { field: PUSHED_AT, direction: DESC }
        ) {
          pageInfo {
            hasNextPage
            endCursor
          }
          nodes {
            nameWithOwner
            isPrivate
            isFork
            isArchived
            owner {
              login
            }
            languages(first: 20, orderBy: { field: SIZE, direction: DESC }) {
              edges {
                size
                node {
                  name
                  color
                }
              }
            }
          }
        }
      }
    }
  `;

  const repositories = [];
  let viewerLogin = null;
  let after = null;
  do {
    const data = await githubGraphql(query, { after });
    viewerLogin = data.viewer?.login || viewerLogin;
    const connection = data.viewer?.repositoriesContributedTo;
    if (!connection) throw new Error("GitHub repository data is unavailable");
    repositories.push(...connection.nodes);
    after = connection.pageInfo.hasNextPage
      ? connection.pageInfo.endCursor
      : null;
  } while (after);

  if (viewerLogin?.toLowerCase() !== login.toLowerCase()) {
    throw new Error(
      `Profile token belongs to ${viewerLogin || "an unknown account"}, expected ${login}`,
    );
  }

  const allowedOwners = new Set([
    login.toLowerCase(),
    ...organizations.map((organization) => organization.login.toLowerCase()),
  ]);
  const ignoredLanguages = new Set([
    "Batchfile",
    "CMake",
    "CSS",
    "Dockerfile",
    "Go Template",
    "HTML",
    "Makefile",
    "NSIS",
    "PLpgSQL",
    "PowerShell",
    "Shell",
  ]);
  const eligibleRepositories = repositories.filter(
    (repository) =>
      !repository.isFork &&
      !repository.isArchived &&
      allowedOwners.has(repository.owner.login.toLowerCase()),
  );

  const languages = new Map();
  const ownerCounts = new Map();
  let publicRepositories = 0;
  let privateRepositories = 0;
  for (const repository of eligibleRepositories) {
    const owner = repository.owner.login.toLowerCase();
    ownerCounts.set(owner, (ownerCounts.get(owner) || 0) + 1);
    if (repository.isPrivate) privateRepositories += 1;
    else publicRepositories += 1;

    for (const edge of repository.languages.edges) {
      if (ignoredLanguages.has(edge.node.name)) continue;
      const current = languages.get(edge.node.name) || {
        name: edge.node.name,
        color: edge.node.color || "#8b949e",
        size: 0,
      };
      current.size += Number(edge.size || 0);
      languages.set(edge.node.name, current);
    }
  }

  const sortedLanguages = [...languages.values()].sort(
    (left, right) => right.size - left.size,
  );
  return {
    repositories: eligibleRepositories.length,
    publicRepositories,
    privateRepositories,
    ownerCounts,
    languages: sortedLanguages,
    totalLanguageBytes: sortedLanguages.reduce(
      (total, language) => total + language.size,
      0,
    ),
  };
}

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  }
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${Math.max(0, Math.round(bytes / 1024))} KB`;
}

function buildLanguageUsageSvg(stats, organizationCount) {
  const topLanguages = stats.languages.slice(0, 8);
  const displayedSize = topLanguages.reduce(
    (total, language) => total + language.size,
    0,
  );
  const otherSize = Math.max(0, stats.totalLanguageBytes - displayedSize);
  const segments = [
    ...topLanguages,
    ...(otherSize > 0
      ? [{ name: "Other", color: "#6e7681", size: otherSize }]
      : []),
  ];

  let segmentX = 48;
  const segmentMarkup = segments
    .map((language, index) => {
      const remainingWidth = 864 - (segmentX - 48);
      const exactWidth =
        stats.totalLanguageBytes > 0
          ? (language.size / stats.totalLanguageBytes) * 864
          : 0;
      const width =
        index === segments.length - 1
          ? remainingWidth
          : Math.max(2, Math.round(exactWidth));
      const markup = `<rect x="${segmentX}" y="134" width="${width}" height="16" fill="${escapeXml(language.color)}"><title>${escapeXml(language.name)} ${((language.size / Math.max(1, stats.totalLanguageBytes)) * 100).toFixed(1)}%</title></rect>`;
      segmentX += width;
      return markup;
    })
    .join("");

  const rows = topLanguages
    .map((language, index) => {
      const column = index % 2;
      const row = Math.floor(index / 2);
      const x = column === 0 ? 48 : 500;
      const y = 188 + row * 44;
      const percentage =
        (language.size / Math.max(1, stats.totalLanguageBytes)) * 100;
      const barWidth = Math.max(2, Math.round((percentage / 100) * 412));
      return `
        <g>
          <rect x="${x}" y="${y - 12}" width="10" height="10" rx="2" fill="${escapeXml(language.color)}"/>
          <text x="${x + 18}" y="${y - 3}" fill="#f8fafc" font-size="14" font-weight="800">${escapeXml(language.name)}</text>
          <text x="${x + 412}" y="${y - 3}" text-anchor="end" fill="#c9d1d9" font-size="13" font-weight="700">${percentage.toFixed(1)}% · ${formatBytes(language.size)}</text>
          <rect x="${x}" y="${y + 8}" width="412" height="5" rx="2" fill="#21262d"/>
          <rect x="${x}" y="${y + 8}" width="${barWidth}" height="5" rx="2" fill="${escapeXml(language.color)}"/>
        </g>`;
    })
    .join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="370" viewBox="0 0 960 370" role="img" aria-labelledby="title desc">
  <title id="title">真实语言使用统计</title>
  <desc id="desc">根据 Birditch 本人和所属组织中实际参与的 ${stats.repositories} 个一方仓库汇总 GitHub Linguist 语言字节。</desc>
  <rect width="960" height="370" rx="8" fill="#0d1117" stroke="#30363d"/>
  <path d="M0 1H960" stroke="#58a6ff" stroke-width="3"/>
  <g font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Arial,sans-serif">
    <text x="48" y="45" fill="#ffffff" font-size="24" font-weight="800">Actual language usage</text>
    <text x="48" y="71" fill="#8b949e" font-size="13">个人 + ${organizationCount} 个组织 · 仅统计实际参与的一方仓库 · 排除 fork、归档与构建标记语言</text>
    <text x="48" y="106" fill="#8b949e" font-size="11" font-weight="800">REPOSITORIES</text>
    <text x="146" y="106" fill="#f8fafc" font-size="18" font-weight="800">${stats.repositories}</text>
    <text x="246" y="106" fill="#8b949e" font-size="11" font-weight="800">PUBLIC / PRIVATE</text>
    <text x="377" y="106" fill="#f8fafc" font-size="18" font-weight="800">${stats.publicRepositories} / ${stats.privateRepositories}</text>
    <text x="524" y="106" fill="#8b949e" font-size="11" font-weight="800">SOURCE VOLUME</text>
    <text x="648" y="106" fill="#f8fafc" font-size="18" font-weight="800">${formatBytes(stats.totalLanguageBytes)}</text>
    ${segmentMarkup}
    ${rows}
    <text x="48" y="351" fill="#6e7681" font-size="11">数据来自 GitHub GraphQL / Linguist；私有仓库只参与聚合，不展示仓库名称或私有内容。</text>
  </g>
</svg>
`;
}

function buildOrganizationOverviewSvg(organizations, stats) {
  const height = 158 + organizations.length * 36 + 28;
  const totalRepositories = organizations.reduce(
    (total, organization) => total + organization.repositoryCount,
    0,
  );
  const participatedRepositories = organizations.reduce(
    (total, organization) =>
      total + (stats.ownerCounts.get(organization.login.toLowerCase()) || 0),
    0,
  );
  const rows = organizations
    .map((organization, index) => {
      const y = 174 + index * 36;
      const participated =
        stats.ownerCounts.get(organization.login.toLowerCase()) || 0;
      const activity = organization.lastPushedAt
        ? organization.lastPushedAt.slice(0, 10)
        : "—";
      return `
        <g>
          <circle cx="54" cy="${y - 5}" r="4" fill="${index === 0 ? "#39d353" : "#58a6ff"}"/>
          <text x="70" y="${y}" fill="#f8fafc" font-size="15" font-weight="800">${escapeXml(organization.login)}</text>
          <text x="535" y="${y}" text-anchor="end" fill="#c9d1d9" font-size="14">${organization.repositoryCount}</text>
          <text x="690" y="${y}" text-anchor="end" fill="#c9d1d9" font-size="14">${participated}</text>
          <text x="912" y="${y}" text-anchor="end" fill="#8b949e" font-size="13">${activity}</text>
          <path d="M48 ${y + 13}H912" stroke="#21262d"/>
        </g>`;
    })
    .join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="${height}" viewBox="0 0 960 ${height}" role="img" aria-labelledby="title desc">
  <title id="title">GitHub 组织概览</title>
  <desc id="desc">Birditch 当前加入 ${organizations.length} 个组织，可访问 ${totalRepositories} 个组织仓库，其中实际参与 ${participatedRepositories} 个一方仓库。</desc>
  <rect width="960" height="${height}" rx="8" fill="#0d1117" stroke="#30363d"/>
  <path d="M0 1H960" stroke="#f0b72f" stroke-width="3"/>
  <g font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Arial,sans-serif">
    <text x="48" y="45" fill="#ffffff" font-size="24" font-weight="800">Organization footprint</text>
    <text x="48" y="71" fill="#8b949e" font-size="13">当前 GitHub 身份可见的全部组织；仓库名称与私有内容不公开。</text>
    <text x="48" y="108" fill="#8b949e" font-size="11" font-weight="800">ORGANIZATIONS</text>
    <text x="164" y="108" fill="#f8fafc" font-size="18" font-weight="800">${organizations.length}</text>
    <text x="272" y="108" fill="#8b949e" font-size="11" font-weight="800">ACCESSIBLE REPOS</text>
    <text x="406" y="108" fill="#f8fafc" font-size="18" font-weight="800">${totalRepositories}</text>
    <text x="516" y="108" fill="#8b949e" font-size="11" font-weight="800">PARTICIPATED</text>
    <text x="625" y="108" fill="#f8fafc" font-size="18" font-weight="800">${participatedRepositories}</text>
    <text x="48" y="146" fill="#6e7681" font-size="11" font-weight="800">ORGANIZATION</text>
    <text x="535" y="146" text-anchor="end" fill="#6e7681" font-size="11" font-weight="800">REPOS</text>
    <text x="690" y="146" text-anchor="end" fill="#6e7681" font-size="11" font-weight="800">USED</text>
    <text x="912" y="146" text-anchor="end" fill="#6e7681" font-size="11" font-weight="800">LAST ACTIVITY</text>
    ${rows}
  </g>
</svg>
`;
}

function buildBadgeSvg({ title, label, value, accent, width }) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="32" viewBox="0 0 ${width} 32" role="img" aria-labelledby="title">
  <title id="title">${escapeXml(title)}</title>
  <rect width="${width}" height="32" rx="6" fill="#0d1117" stroke="#30363d"/>
  <rect width="5" height="32" rx="2" fill="${accent}"/>
  <circle cx="22" cy="16" r="4" fill="${accent}"/>
  <g font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Arial,sans-serif">
    <text x="34" y="20" fill="#8b949e" font-size="11" font-weight="800">${escapeXml(label)}</text>
    <text x="${width - 12}" y="20" text-anchor="end" fill="#f8fafc" font-size="13" font-weight="800">${escapeXml(value)}</text>
  </g>
</svg>
`;
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
const [calendar, profile, organizations] = await Promise.all([
  fetchContributionCalendar(calendarFrom, calendarTo),
  fetchUserProfile(),
  fetchOrganizations(),
]);
const repositoryStats = await fetchRepositoryLanguageStats(organizations);

await Promise.all([
  writeSvg(weeklyOutput, buildWeeklySvg(weeklyDays)),
  writeSvg(contributionsOutput, buildContributionSvg(calendar)),
  writeSvg(
    languageUsageOutput,
    buildLanguageUsageSvg(repositoryStats, organizations.length),
  ),
  writeSvg(
    organizationOverviewOutput,
    buildOrganizationOverviewSvg(organizations, repositoryStats),
  ),
  writeSvg(
    githubBadgeOutput,
    buildBadgeSvg({
      title: `GitHub profile for ${profile.login}`,
      label: "GITHUB",
      value: `@${profile.login}`,
      accent: "#58a6ff",
      width: 188,
    }),
  ),
  writeSvg(
    followersBadgeOutput,
    buildBadgeSvg({
      title: `${profile.followers} GitHub followers`,
      label: "FOLLOWERS",
      value: profile.followers,
      accent: "#2ea043",
      width: 154,
    }),
  ),
  writeSvg(
    timezoneBadgeOutput,
    buildBadgeSvg({
      title: "New York time zone UTC-04",
      label: "NEW YORK",
      value: "UTC-04",
      accent: "#f0b72f",
      width: 170,
    }),
  ),
]);
