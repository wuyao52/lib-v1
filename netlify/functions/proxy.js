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

  // 获取请求路径
  // Netlify 会将 /api/hongniaoai/v1/models 重定向到 /.netlify/functions/proxy/v1/models
  // event.path 会是 /.netlify/functions/proxy/v1/models
  let targetPath = event.path.replace(/^\/.netlify\/functions\/proxy\/?/, '');

  // 如果路径为空，尝试从查询参数获取
  if (!targetPath) {
    const { path } = event.queryStringParameters || {};
    if (path) {
      targetPath = path.replace(/^hongniaoai\//, '');
    }
  }

  if (!targetPath) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'Missing path parameter', path: event.path }),
    };
  }

  // 构建目标 URL
  const targetUrl = `https://open.hongniaoai.com/api/${targetPath}`;

  console.log('代理请求:', {
    eventPath: event.path,
    targetPath,
    targetUrl,
    method: event.httpMethod,
  });

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