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

  // 获取请求路径 - 从 URL 中提取
  // 请求格式: /api/proxy?path=hongniaoai/v1/models
  // 或者: /api/hongniaoai/v1/models (通过 rewrite)
  const { path } = req.query;

  // 构建目标路径
  let targetPath = '';
  if (path) {
    targetPath = Array.isArray(path) ? path.join('/') : path;
  } else {
    // 从 URL 中提取路径
    const url = req.url || '';
    const match = url.match(/\/api\/proxy\?path=(.+)/);
    if (match) {
      targetPath = decodeURIComponent(match[1]);
    }
  }

  // 移除路径开头的 hongniaoai/（如果存在）
  // 因为前端请求的是 /api/hongniaoai/v1/models
  // 但目标 API 是 https://open.hongniaoai.com/api/v1/models
  targetPath = targetPath.replace(/^hongniaoai\//, '');

  // 构建目标 URL
  const targetUrl = `https://open.hongniaoai.com/api/${targetPath}`;

  console.log('代理请求:', {
    originalUrl: req.url,
    queryPath: path,
    targetPath,
    targetUrl,
    method: req.method,
  });

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

    console.log('发送请求到:', targetUrl, fetchOptions);

    const response = await fetch(targetUrl, fetchOptions);
    const data = await response.json();

    console.log('响应:', { status: response.status, data });

    res.status(response.status).json(data);
  } catch (error) {
    console.error('代理错误:', error);
    res.status(500).json({
      code: 500,
      error: '代理请求失败',
      message: error.message
    });
  }
}
