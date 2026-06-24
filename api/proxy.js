// Vercel Serverless Function - API 代理
export default async function handler(req, res) {
  // 设置 CORS 头
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key');

  // 处理预检请求
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  // 获取目标路径
  const { path } = req.query;
  const targetPath = Array.isArray(path) ? path.join('/') : path || '';

  // 构建目标 URL
  const targetUrl = `https://open.hongniaoai.com/api/${targetPath}`;

  try {
    // 转发请求
    const headers = {
      'Content-Type': 'application/json',
    };

    // 转发认证头
    if (req.headers.authorization) {
      headers['Authorization'] = req.headers.authorization;
    }
    if (req.headers['x-api-key']) {
      headers['X-API-Key'] = req.headers['x-api-key'];
    }

    const fetchOptions = {
      method: req.method,
      headers,
    };

    // 如果有请求体，转发它
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.body) {
      fetchOptions.body = JSON.stringify(req.body);
    }

    const response = await fetch(targetUrl, fetchOptions);
    const data = await response.json();

    res.status(response.status).json(data);
  } catch (error) {
    console.error('代理错误:', error);
    res.status(500).json({ error: '代理请求失败', message: error.message });
  }
}
