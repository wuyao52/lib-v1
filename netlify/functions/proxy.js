// Netlify Function - API 代理（支持多个 API 服务）
exports.handler = async (event, context) => {
  // 设置 CORS 头
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Key',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  };

  // 处理预检请求
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  const eventPath = event.path || '';
  const queryParams = event.queryStringParameters || {};

  console.log('请求路径:', eventPath);

  // 确定目标 API 和路径
  let targetBase = '';
  let targetPath = '';

  if (eventPath.includes('/api/hongniaoai') || queryParams.service === 'hongniaoai') {
    // 红鸟AI
    targetBase = 'https://open.hongniaoai.com/api';
    targetPath = queryParams.path || eventPath.split('/api/hongniaoai/')[1] || '';
  } else if (eventPath.includes('/api/wuhenai') || queryParams.service === 'wuhenai') {
    // 无痕AI
    targetBase = 'https://api.wuhenai.com';
    targetPath = queryParams.path || eventPath.split('/api/wuhenai/')[1] || '';
  } else {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'Unknown API service', path: eventPath }),
    };
  }

  if (!targetPath) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'Missing path', path: eventPath }),
    };
  }

  const targetUrl = `${targetBase}/${targetPath}`;
  console.log('目标URL:', targetUrl);

  try {
    const requestHeaders = { 'Content-Type': 'application/json' };

    if (event.headers.authorization) {
      requestHeaders['Authorization'] = event.headers.authorization;
    }
    if (event.headers['x-api-key']) {
      requestHeaders['X-API-Key'] = event.headers['x-api-key'];
    }

    const fetchOptions = {
      method: event.httpMethod,
      headers: requestHeaders,
    };

    if (event.body && event.httpMethod !== 'GET' && event.httpMethod !== 'HEAD') {
      fetchOptions.body = event.body;
    }

    const response = await fetch(targetUrl, fetchOptions);
    const data = await response.json();

    return {
      statusCode: response.status,
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    };
  } catch (error) {
    console.error('代理错误:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ code: 500, error: '代理请求失败', message: error.message }),
    };
  }
};