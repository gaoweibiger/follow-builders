#!/usr/bin/env node
// ============================================================================
// follow-builders + AI HOT 综合日报
//   拉取 builder feed + aihot 资讯 → 智谱 GLM 生成综合日报 → 飞书纯文本消息
// 零依赖：仅使用 Node 20+ 内置 fetch
//   说明：改用 msg_type=text 纯文本（原 follow-builders 标准格式），飞书会自动把裸 URL
//         识别成可点击链接——避开交互式卡片对 markdown 解析不全导致格式不显示的问题。
// ============================================================================

// ======================== 内容源 ========================
const FEED_X    = 'https://raw.githubusercontent.com/zarazhangrui/follow-builders/main/feed-x.json';
const FEED_POD  = 'https://raw.githubusercontent.com/zarazhangrui/follow-builders/main/feed-podcasts.json';
const FEED_BLOG = 'https://raw.githubusercontent.com/zarazhangrui/follow-builders/main/feed-blogs.json';
const PROMPTS   = 'https://raw.githubusercontent.com/zarazhangrui/follow-builders/main/prompts';

// AI HOT 公开只读 API（合并的第二个内容源，无需 key）
const INCLUDE_AIHOT = (process.env.INCLUDE_AIHOT ?? 'true') !== 'false'; // 默认开启
// aihot /api/public/* 走 nginx UA 黑名单挡爬虫，必须带「浏览器 UA + aihot-skill 标识」，否则 403
const AIHOT_UA   = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 aihot-skill/0.3.6';
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

const TEXT_MAX_BYTES = 30000; // 飞书单条文本消息上限 30720 字节，按 UTF-8 字节留余量分条

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

// ======================== 文本分条 ========================
// 原 follow-builders 标准格式：直接发 msg_type=text 纯文本。
// 飞书会自动把裸 URL 识别成可点击链接，无需卡片/markdown 解析。
// 仅当内容超过单条消息字节上限（30720B）时，按段落切分成多条发送。
const utf8Bytes = s => Buffer.byteLength(s, 'utf8');
function splitText(text, maxBytes) {
  if (utf8Bytes(text) <= maxBytes) return [text];
  const chunks = [];
  let cur = '';
  for (const para of text.split(/\n{2,}/)) {
    const piece = (cur ? cur + '\n\n' : '') + para;
    if (utf8Bytes(piece) > maxBytes) {
      if (cur) { chunks.push(cur); cur = ''; }
      if (utf8Bytes(para) <= maxBytes) {
        cur = para;
      } else { // 单段超长，按字符逐步累加到字节上限
        let buf = '';
        for (const ch of para) {
          if (utf8Bytes(buf + ch) > maxBytes) { chunks.push(buf); buf = ch; }
          else buf += ch;
        }
        if (buf) cur = buf;
      }
    } else {
      cur = piece;
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
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
    '输出格式要求（必须严格遵守，用于飞书纯文本消息）：'
    + '① 整篇用纯文本输出，禁止任何 Markdown 符号——不要 # 标题、不要 **加粗**、不要 *斜体*、不要 [文字](URL)、不要反引号；'
    + '② 章节标题用全大写字母或 emoji 单独成行（例如「X / TWITTER」「OFFICIAL BLOGS」「PODCASTS」「🤖 AI 行业动态」「🔥 今日热点」）；'
    + '③ 要点一律用「- 」开头逐行列出；'
    + '④ 所有来源链接一律用裸 URL 单独成行（例如 https://x.com/levie/status/xxx 或 https://aihot.virxact.com/items/xxx），飞书纯文本消息会自动识别成可点击链接，绝不要用 [文字](URL) 包裹；'
    + '⑤ 段落之间空一行，确保手机上可扫读；'
    + '⑥ X/Twitter 作者不要带 @（写成「Aaron Levie (levie on X)」即可）。',
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

  // 6. 按原 follow-builders 纯文本格式分条（飞书 msg_type=text）
  const fullText = `${todayTitle()}\n\n${digest}`;
  const chunks = splitText(fullText, TEXT_MAX_BYTES);
  console.log(`构建 ${chunks.length} 条文本消息，共 ${utf8Bytes(fullText)} 字节`);

  // 7. 发飞书：换取 tenant_access_token
  console.log('获取飞书 token ...');
  const tokenRes = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: FEISHU_APP_ID, app_secret: FEISHU_APP_SECRET }),
  }).then(r => r.json());
  if (tokenRes.code !== 0) throw new Error(`飞书 token 失败: ${tokenRes.msg}`);

  // 8. 逐条发送纯文本消息到个人
  for (let i = 0; i < chunks.length; i++) {
    const sendRes = await fetch('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenRes.tenant_access_token}` },
      body: JSON.stringify({
        receive_id: FEISHU_OPEN_ID,
        msg_type: 'text',
        content: JSON.stringify({ text: chunks[i] }),
      }),
    }).then(r => r.json());
    if (sendRes.code !== 0) throw new Error(`飞书发送第 ${i + 1} 条文本失败: ${sendRes.msg}`);
    console.log(`  ✅ 文本 ${i + 1}/${chunks.length} 已发送`);
    if (i < chunks.length - 1) await new Promise(r => setTimeout(r, 300));
  }
  console.log('🎉 全部发送完成');
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
