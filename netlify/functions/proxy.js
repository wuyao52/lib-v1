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
  // 当请求 /api/hongniaoai/v1/models 时
  // Netlify 重定向到 /.netlify/functions/proxy/v1/models
  // event.path 会是 /.netlify/functions/proxy/v1/models

  console.log('原始路径:', event.path);
  console.log('查询参数:', event.queryStringParameters);

  // 从路径中提取目标路径
  let targetPath = '';

  // 尝试从 event.path 获取
  const pathMatch = event.path.match(/\/.netlify\/functions\/proxy\/?(.*)/);
  if (pathMatch && pathMatch[1]) {
    targetPath = pathMatch[1];
  }

  // 如果路径为空，尝试从查询参数获取
  if (!targetPath && event.queryStringParameters && event.queryStringParameters.path) {
    targetPath = event.queryStringParameters.path.replace(/^hongniaoai\//, '');
  }

  // 如果还是为空，返回错误
  if (!targetPath) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({
        error: 'Missing path',
        eventPath: event.path,
        queryParams: event.queryStringParameters
      }),
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

    console.log('发送请求到:', targetUrl, fetchOptions);

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