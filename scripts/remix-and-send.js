#!/usr/bin/env node
// ============================================================================
// follow-builders: 拉取 feed → 调智谱 GLM 生成摘要 → 飞书交互式卡片推送
// 零依赖：仅使用 Node 20+ 内置 fetch
//
// 环境变量（来自 GitHub Secrets，见 .github/workflows/feishu-digest.yml）：
//   LLM_API_KEY        智谱 API Key（必填）
//   LLM_MODEL          模型 ID，默认 glm-5
//   LLM_MAX_TOKENS     输出上限，默认 8192（想要更详细可调到 12000~16000）
//   DIGEST_LANGUAGE    zh / en / bilingual，默认 zh
//   DIGEST_PREFERENCE  推送偏好（自然语言），如"把摘要写得更详细一些"
//   FEISHU_APP_ID      飞书 App ID（必填）
//   FEISHU_APP_SECRET  飞书 App Secret（必填）
//   FEISHU_OPEN_ID     收件人 open_id，ou_ 开头（必填）
// ============================================================================

// ======================== 配置 ========================
const FEED_X    = 'https://raw.githubusercontent.com/zarazhangrui/follow-builders/main/feed-x.json';
const FEED_POD  = 'https://raw.githubusercontent.com/zarazhangrui/follow-builders/main/feed-podcasts.json';
const FEED_BLOG = 'https://raw.githubusercontent.com/zarazhangrui/follow-builders/main/feed-blogs.json';
const PROMPTS   = 'https://raw.githubusercontent.com/zarazhangrui/follow-builders/main/prompts';

const LLM_BASE    = process.env.LLM_BASE_URL || 'https://open.bigmodel.cn/api/coding/paas/v4';
const LLM_KEY     = process.env.LLM_API_KEY;
const LLM_MODEL   = process.env.LLM_MODEL || 'glm-4.6';
const LLM_TOKENS  = Number(process.env.LLM_MAX_TOKENS || 8192);
const LANGUAGE    = process.env.DIGEST_LANGUAGE || 'zh';          // zh / en / bilingual
const PREFERENCE  = (process.env.DIGEST_PREFERENCE || '').trim(); // 自然语言偏好

const FEISHU_APP_ID     = process.env.FEISHU_APP_ID;
const FEISHU_APP_SECRET = process.env.FEISHU_APP_SECRET;
const FEISHU_OPEN_ID    = process.env.FEISHU_OPEN_ID;

const CARD_MAX_CHARS  = 26000; // 单张卡片累计字符上限（保守，飞书单卡约 30KB）
const BLOCK_MAX_CHARS = 28000; // 单个 div 内容上限

// ======================== 工具 ========================
const j = u => fetch(u).then(r => (r.ok ? r.json() : null));
const t = u => fetch(u).then(r => (r.ok ? r.text() : ''));

// 裁剪 feed，控制输入 token 量（避免撞智谱 TPM 限流，同时更快更省）
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

// ======================== 卡片构建 ========================
// 把 Markdown 摘要拆成 lark_md 元素，并打包成多张卡片（超长自动分卡）
function buildElements(md) {
  // 优先按 Markdown 标题行拆，其次按空行段落拆
  const blocks = md
    .split(/\n(?=#{1,6}\s)|\n{2,}/)
    .map(s => s.trim())
    .filter(Boolean);

  const elements = [];
  for (const b of blocks) {
    if (b.length > BLOCK_MAX_CHARS) {
      // 单块过长则硬拆
      for (let i = 0; i < b.length; i += BLOCK_MAX_CHARS) {
        elements.push({ tag: 'div', text: { tag: 'lark_md', content: b.slice(i, i + BLOCK_MAX_CHARS) } });
      }
    } else {
      elements.push({ tag: 'div', text: { tag: 'lark_md', content: b } });
    }
    elements.push({ tag: 'hr' });
  }
  // 去掉末尾多余的 hr
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
  return `🤖 AI Builders 每日摘要 · ${d}`;
}

// ======================== 主流程 ========================
async function main() {
  // 本地代理（Actions 无需）：Node 24 设 NODE_USE_ENV_PROXY=1 + HTTPS_PROXY 即可走代理
  // 1. 拉取 feed + prompts（并行）
  console.log('拉取 feed 与 prompts ...');
  const [feedX, feedPod, feedBlog, pDigest, pTweets, pPod, pTrans, pBlog] = await Promise.all([
    j(FEED_X), j(FEED_POD), j(FEED_BLOG),
    t(`${PROMPTS}/digest-intro.md`), t(`${PROMPTS}/summarize-tweets.md`),
    t(`${PROMPTS}/summarize-podcast.md`), t(`${PROMPTS}/translate.md`),
    t(`${PROMPTS}/summarize-blogs.md`),
  ]);

  const hasX    = !!(feedX?.x?.length);
  const hasPod  = !!(feedPod?.podcasts?.length);
  const hasBlog = !!(feedBlog?.blogs?.length || feedBlog?.articles?.length || (Array.isArray(feedBlog) && feedBlog.length));
  if (!hasX && !hasPod && !hasBlog) {
    console.log('今天没有新内容，跳过');
    return;
  }

  // 2. 拼接 system prompt
  const langRule = {
    zh:        '整个摘要用中文输出（英文内容翻译成中文）。',
    en:        'Output the entire digest in English.',
    bilingual: '每段先英文后中文，逐段交错。',
  }[LANGUAGE];

  const parts = [
    pDigest, pTweets, pPod, pTrans, pBlog,
    '语言要求：' + langRule,
    '链接格式要求：所有来源链接一律用 Markdown 链接格式 `[文字](URL)`，确保在消息卡片中可点击。',
  ];
  if (PREFERENCE) {
    parts.push(`【用户偏好（必须严格遵守）】${PREFERENCE}`);
  }
  const system = parts.filter(Boolean).join('\n\n');

  const trimmed = trimFeed(feedX, feedPod, feedBlog);
  const content = JSON.stringify({
    generatedAt: feedX?.generatedAt,
    note: 'transcript/content 已截断以控制篇幅，请基于以上内容总结核心观点',
    stats: {
      xBuilders: trimmed.x.length,
      podcastEpisodes: trimmed.podcasts.length,
      blogPosts: trimmed.blogs.length,
    },
    ...trimmed,
  });
  console.log(`输入裁剪后约 ${content.length} 字符`);

  // 3. 调智谱 GLM（OpenAI 兼容接口，429/5xx 自动退避重试）
  console.log(`调用智谱 ${LLM_MODEL} 生成摘要 ...`);
  const llmBody = JSON.stringify({
    model: LLM_MODEL,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: `根据以下原始内容(JSON)生成今日 digest。每条内容必须带原始 url，禁止编造：\n\n${content}` },
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
      const wait = attempt * 10; // 10s, 20s, 30s
      console.log(`LLM 返回 ${resp.status}（第 ${attempt}/3 次重试），${wait}s 后重试 ...`);
      await new Promise(r => setTimeout(r, wait * 1000));
      continue;
    }
    throw new Error(`LLM 调用失败 ${resp.status}: ${errBody}`);
  }
  if (!digest) throw new Error('LLM 返回为空');
  console.log(`digest 已生成，长度 ${digest.length} 字符`);

  // 4. 构建飞书卡片
  const elements = buildElements(digest);
  const cards = packCards(elements, todayTitle());
  console.log(`构建 ${cards.length} 张卡片`);

  // 5. 发飞书：换取 tenant_access_token
  console.log('获取飞书 token ...');
  const tokenRes = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: FEISHU_APP_ID, app_secret: FEISHU_APP_SECRET }),
  }).then(r => r.json());
  if (tokenRes.code !== 0) throw new Error(`飞书 token 失败: ${tokenRes.msg}`);

  // 6. 逐张发送交互式卡片到个人（receive_id_type=open_id）
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
    if (i < cards.length - 1) await new Promise(r => setTimeout(r, 300)); // 避免限流
  }
  console.log('🎉 全部发送完成');
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
