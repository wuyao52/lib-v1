// Vercel Serverless Function - 多平台 API 代理
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  const { path } = req.query;
  let targetPath = '';
  if (path) {
    targetPath = Array.isArray(path) ? path.join('/') : path;
  }

  // 根据路径前缀路由到不同的 API 平台
  let targetUrl = '';
  if (targetPath.startsWith('hongniaoai/')) {
    // 红鸟AI
    targetPath = targetPath.replace(/^hongniaoai\//, '');
    targetUrl = `https://open.hongniaoai.com/api/${targetPath}`;
  } else if (targetPath.startsWith('toapis/')) {
    // ToAPIs - OpenAI 兼容
    targetPath = targetPath.replace(/^toapis\//, '');
    targetUrl = `https://toapis.com/v1/${targetPath}`;
  } else if (targetPath.startsWith('wuhenai/')) {
    // 无痕AI
    targetPath = targetPath.replace(/^wuhenai\//, '');
    targetUrl = `https://api.wuhenai.com/${targetPath}`;
  }

  if (!targetUrl) {
    res.status(400).json({ error: '未知的 API 平台' });
    return;
  }

  try {
    const headers = { 'Content-Type': 'application/json' };
    if (req.headers.authorization) {
      headers['Authorization'] = req.headers.authorization;
    }
    if (req.headers['x-api-key']) {
      headers['X-API-Key'] = req.headers['x-api-key'];
    }

    const fetchOptions = { method: req.method, headers };
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.body) {
      fetchOptions.body = JSON.stringify(req.body);
    }

    const response = await fetch(targetUrl, fetchOptions);
    const data = await response.json();

    res.status(response.status).json(data);
  } catch (error) {
    res.status(500).json({ code: 500, error: '代理失败', message: error.message });
  }
}
