#!/usr/bin/env node
// ============================================================================
// follow-builders + AI HOT 综合日报
//   拉取 builder feed + aihot 资讯 → 智谱 GLM 生成综合日报 → 飞书交互式卡片
// 零依赖：仅使用 Node 20+ 内置 fetch
// ============================================================================

// ======================== 内容源 ========================
const FEED_X    = 'https://raw.githubusercontent.com/zarazhangrui/follow-builders/main/feed-x.json';
const FEED_POD  = 'https://raw.githubusercontent.com/zarazhangrui/follow-builders/main/feed-podcasts.json';
const FEED_BLOG = 'https://raw.githubusercontent.com/zarazhangrui/follow-builders/main/feed-blogs.json';
const PROMPTS   = 'https://raw.githubusercontent.com/zarazhangrui/follow-builders/main/prompts';

// AI HOT 公开只读 API（合并的第二个内容源，无需 key）
const INCLUDE_AIHOT = (process.env.INCLUDE_AIHOT ?? 'true') !== 'false'; // 默认开启
const AIHOT_UA   = 'aihot-skill/0.3.6 (+https://aihot.virxact.com/aihot-skill/)';
const AIHOT_BASE = 'https://aihot.virxact.com/api/public';

// ======================== LLM / 飞书 配置 ========================
const LLM_BASE    = process.env.LLM_BASE_URL || 'https://open.bigmodel.cn/api/coding/paas/v4';
const LLM_KEY     = process.env.LLM_API_KEY;
const LLM_MODEL   = process.env.LLM_MODEL || 'glm-5-turbo';
const LLM_TOKENS  = Number(process.env.LLM_MAX_TOKENS || 8192);
const LANGUAGE    = process.env.DIGEST_LANGUAGE || 'zh';          // zh / en / bilingual
const PREFERENCE  = (process.env.DIGEST_PREFERENCE || '').trim(); // 自然语言偏好

const FEISHU_APP_ID     = process.env.FEISHU_APP_ID;
const FEISHU_APP_SECRET = process.env.FEISHU_APP_SECRET;
const FEISHU_OPEN_ID    = process.env.FEISHU_OPEN_ID;

const CARD_MAX_CHARS  = 26000; // 单张卡片累计字符上限
const BLOCK_MAX_CHARS = 28000; // 单个 div 内容上限

// ======================== 工具 ========================
const j  = u => fetch(u).then(r => (r.ok ? r.json() : null));
const t  = u => fetch(u).then(r => (r.ok ? r.text() : ''));
const ja = (u, h) => fetch(u, { headers: h }).then(r => (r.ok ? r.json() : null));

// ---- 裁剪 builder feed，控制输入 token ----
const TRUNC = { transcript: 9000, tweetText: 600, blogContent: 4000 };
function trimFeed(feedX, feedPod, feedBlog) {
  const x = (feedX?.x || []).map(b => ({
    name: b.name, handle: b.handle, bio: b.bio,
    tweets: (b.tweets || []).map(tw => ({
      url: tw.url, createdAt: tw.createdAt,
      text: (tw.text || '').slice(0, TRUNC.tweetText),
    })),
  }));
  const podcasts = (feedPod?.podcasts || []).map(p => ({
    name: p.name, title: p.title, url: p.url,
    transcript: (p.transcript || '').slice(0, TRUNC.transcript),
  }));
  const blogArr = feedBlog?.blogs || feedBlog?.articles || (Array.isArray(feedBlog) ? feedBlog : []);
  const blogs = blogArr.map(b => ({
    name: b.name, title: b.title, url: b.url, author: b.author,
    description: b.description,
    content: (b.content || '').slice(0, TRUNC.blogContent),
  }));
  return { x, podcasts, blogs };
}

// ---- 裁剪 aihot 资讯 ----
function trimAihot(aihot) {
  if (!aihot) return null;
  return {
    hot: (aihot.hot || []).slice(0, 5).map(h => ({
      title: h.title, permalink: h.permalink, sourceCount: h.sourceCount,
    })),
    items: (aihot.items || []).slice(0, 12).map(it => ({
      title: it.title, category: it.category, permalink: it.permalink,
      summary: (it.summary || '').slice(0, 220),
    })),
  };
}

// ======================== 卡片构建 ========================
function buildElements(md) {
  const blocks = md
    .split(/\n(?=#{1,6}\s)|\n{2,}/)
    .map(s => s.trim())
    .filter(Boolean);

  const elements = [];
  for (const b of blocks) {
    if (b.length > BLOCK_MAX_CHARS) {
      for (let i = 0; i < b.length; i += BLOCK_MAX_CHARS) {
        elements.push({ tag: 'div', text: { tag: 'lark_md', content: b.slice(i, i + BLOCK_MAX_CHARS) } });
      }
    } else {
      elements.push({ tag: 'div', text: { tag: 'lark_md', content: b } });
    }
    elements.push({ tag: 'hr' });
  }
  while (elements.length && elements[elements.length - 1].tag === 'hr') elements.pop();
  return elements;
}

function packCards(elements, title) {
  const cards = [];
  let cur = [], curLen = 0;
  for (const el of elements) {
    const elLen = (el.text?.content?.length || 0) + 40;
    if (curLen + elLen > CARD_MAX_CHARS && cur.length) {
      cards.push(cur); cur = []; curLen = 0;
    }
    cur.push(el); curLen += elLen;
  }
  if (cur.length) cards.push(cur);

  return cards.map((els, i) => ({
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: i === 0 ? title : `${title}（续 ${i + 1}）` },
      template: 'blue',
    },
    elements: els,
  }));
}

function todayTitle() {
  const d = new Date().toLocaleDateString('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: 'long', day: 'numeric', weekday: 'long',
  });
  return `🤖 AI 每日综合日报 · ${d}`;
}

// ======================== 主流程 ========================
async function main() {
  // 1. 拉取 builder feed + prompts（并行）
  console.log('拉取 builder feed 与 prompts ...');
  const [feedX, feedPod, feedBlog, pDigest, pTweets, pPod, pTrans, pBlog] = await Promise.all([
    j(FEED_X), j(FEED_POD), j(FEED_BLOG),
    t(`${PROMPTS}/digest-intro.md`), t(`${PROMPTS}/summarize-tweets.md`),
    t(`${PROMPTS}/summarize-podcast.md`), t(`${PROMPTS}/translate.md`),
    t(`${PROMPTS}/summarize-blogs.md`),
  ]);

  // 2. 拉取 AI HOT 资讯（可选，带指定 UA）
  let aihotRaw = null;
  if (INCLUDE_AIHOT) {
    console.log('拉取 AI HOT 资讯 ...');
    const since = new Date(Date.now() - 36 * 3600 * 1000).toISOString();
    const [items, hot] = await Promise.all([
      ja(`${AIHOT_BASE}/items?mode=selected&since=${since}&take=15`, { 'User-Agent': AIHOT_UA }),
      ja(`${AIHOT_BASE}/hot-topics`, { 'User-Agent': AIHOT_UA }),
    ]);
    aihotRaw = { items: items?.items || [], hot: hot?.items || [] };
    console.log(`AI HOT: ${aihotRaw.items.length} 条精选, ${aihotRaw.hot.length} 条热点`);
  }

  // 3. 裁剪
  const trimmed = trimFeed(feedX, feedPod, feedBlog);
  const trimmedAihot = trimAihot(aihotRaw);

  const hasX    = !!trimmed.x.length;
  const hasPod  = !!trimmed.podcasts.length;
  const hasBlog = !!trimmed.blogs.length;
  const hasAihot = !!(trimmedAihot?.items?.length || trimmedAihot?.hot?.length);
  if (!hasX && !hasPod && !hasBlog && !hasAihot) {
    console.log('今天没有任何内容，跳过');
    return;
  }

  // 4. 拼接 system prompt
  const langRule = {
    zh:        '整个日报用中文输出（英文内容翻译成中文）。',
    en:        'Output the entire digest in English.',
    bilingual: '每段先英文后中文，逐段交错。',
  }[LANGUAGE];

  const parts = [
    pDigest, pTweets, pPod, pTrans, pBlog,
    '语言要求：' + langRule,
    '链接格式要求：所有来源链接一律用 Markdown 链接格式 `[文字](URL)`，确保在消息卡片中可点击。',
  ];
  if (INCLUDE_AIHOT && hasAihot) {
    parts.push(
      '内容构成：本日报整合两类素材——' +
      '「AI 行业资讯」（字段 aihot，来自 AI HOT 公开数据，已是中文，直接采用，保留来源标注）和 ' +
      '「Builder 动态」（字段 x/podcasts/blogs，英文，需翻译）。' +
      '请产出一份连贯的中文日报，建议结构：' +
      '①「今日热点速览」用 aihot.hot 每条 1 句 + 链接；' +
      '②「AI 行业动态」综合 aihot.items；' +
      '③「Builder 观点」综合 x/podcasts/blogs。' +
      '两类素材都要覆盖，不要遗漏任一类。'
    );
  }
  if (PREFERENCE) parts.push(`【用户偏好（必须严格遵守）】${PREFERENCE}`);
  const system = parts.filter(Boolean).join('\n\n');

  const content = JSON.stringify({
    generatedAt: feedX?.generatedAt,
    note: '内容已截断以控制篇幅，请基于以上内容总结核心观点',
    stats: {
      xBuilders: trimmed.x.length,
      podcastEpisodes: trimmed.podcasts.length,
      blogPosts: trimmed.blogs.length,
      aihotItems: trimmedAihot?.items?.length || 0,
      aihotHot: trimmedAihot?.hot?.length || 0,
    },
    ...trimmed,
    aihot: trimmedAihot,
  });
  console.log(`输入约 ${content.length} 字符`);

  // 5. 调智谱 GLM（429/5xx 自动退避重试）
  console.log(`调用智谱 ${LLM_MODEL} 生成综合日报 ...`);
  const llmBody = JSON.stringify({
    model: LLM_MODEL,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: `根据以下原始内容(JSON)生成今日综合日报。每条内容必须带原始链接，禁止编造：\n\n${content}` },
    ],
    temperature: 0.7,
    max_tokens: LLM_TOKENS,
  });
  let digest = '';
  for (let attempt = 1; attempt <= 4; attempt++) {
    const resp = await fetch(`${LLM_BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${LLM_KEY}` },
      body: llmBody,
    });
    if (resp.ok) {
      digest = ((await resp.json()).choices?.[0]?.message?.content || '').trim();
      break;
    }
    const errBody = await resp.text();
    if ((resp.status === 429 || resp.status >= 500) && attempt < 4) {
      const wait = attempt * 10;
      console.log(`LLM 返回 ${resp.status}（第 ${attempt}/3 次重试），${wait}s 后重试 ...`);
      await new Promise(r => setTimeout(r, wait * 1000));
      continue;
    }
    throw new Error(`LLM 调用失败 ${resp.status}: ${errBody}`);
  }
  if (!digest) throw new Error('LLM 返回为空');
  console.log(`日报已生成，长度 ${digest.length} 字符`);

  // 6. 构建飞书卡片
  const elements = buildElements(digest);
  const cards = packCards(elements, todayTitle());
  console.log(`构建 ${cards.length} 张卡片`);

  // 7. 发飞书：换取 tenant_access_token
  console.log('获取飞书 token ...');
  const tokenRes = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: FEISHU_APP_ID, app_secret: FEISHU_APP_SECRET }),
  }).then(r => r.json());
  if (tokenRes.code !== 0) throw new Error(`飞书 token 失败: ${tokenRes.msg}`);

  // 8. 逐张发送交互式卡片到个人
  for (let i = 0; i < cards.length; i++) {
    const sendRes = await fetch('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenRes.tenant_access_token}` },
      body: JSON.stringify({
        receive_id: FEISHU_OPEN_ID,
        msg_type: 'interactive',
        content: JSON.stringify(cards[i]),
      }),
    }).then(r => r.json());
    if (sendRes.code !== 0) throw new Error(`飞书发送第 ${i + 1} 张卡片失败: ${sendRes.msg}`);
    console.log(`  ✅ 卡片 ${i + 1}/${cards.length} 已发送`);
    if (i < cards.length - 1) await new Promise(r => setTimeout(r, 300));
  }
  console.log('🎉 全部发送完成');
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
