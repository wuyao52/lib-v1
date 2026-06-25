// Netlify Function - API 代理
exports.handler = async (event, context) => {
  // 设置 CORS 头
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Key',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  };

  // 处理预检请求
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers,
      body: '',
    };
  }

  // 获取路径参数
  const { path } = event.queryStringParameters || {};

  if (!path) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'Missing path parameter' }),
    };
  }

  // 移除路径开头的 hongniaoai/
  const targetPath = path.replace(/^hongniaoai\//, '');

  // 构建目标 URL
  const targetUrl = `https://open.hongniaoai.com/api/${targetPath}`;

  console.log('代理请求:', { path, targetPath, targetUrl, method: event.httpMethod });

  try {
    // 构建请求头
    const requestHeaders = {
      'Content-Type': 'application/json',
    };

    // 转发认证头
    if (event.headers.authorization) {
      requestHeaders['Authorization'] = event.headers.authorization;
    }
    if (event.headers['x-api-key']) {
      requestHeaders['X-API-Key'] = event.headers['x-api-key'];
    }

    // 构建请求选项
    const fetchOptions = {
      method: event.httpMethod,
      headers: requestHeaders,
    };

    // 如果有请求体，转发它
    if (event.body && event.httpMethod !== 'GET' && event.httpMethod !== 'HEAD') {
      fetchOptions.body = event.body;
    }

    console.log('发送请求到:', targetUrl);

    // 发送请求
    const response = await fetch(targetUrl, fetchOptions);
    const data = await response.json();

    console.log('响应:', { status: response.status, data });

    return {
      statusCode: response.status,
      headers: {
        ...headers,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(data),
    };
  } catch (error) {
    console.error('代理错误:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        code: 500,
        error: '代理请求失败',
        message: error.message,
      }),
    };
  }
};