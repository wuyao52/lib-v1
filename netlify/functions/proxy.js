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
  const eventPath = event.path || '';
  const queryParams = event.queryStringParameters || {};

  console.log('请求路径:', eventPath);
  console.log('查询参数:', queryParams);

  // 直接从路径中提取目标路径
  // event.path 可能是 /api/hongniaoai/v1/models 或 /.netlify/functions/proxy
  let targetPath = '';

  // 方式1：从查询参数获取
  if (queryParams.path) {
    targetPath = queryParams.path;
  }

  // 方式2：从 event.path 获取
  if (!targetPath) {
    // 匹配 /api/hongniaoai/v1/xxx 或 /.netlify/functions/proxy/v1/xxx
    const match = eventPath.match(/(?:\/api\/hongniaoai|\/.netlify\/functions\/proxy)\/?(.*)/);
    if (match && match[1]) {
      targetPath = match[1];
    }
  }

  // 方式3：如果路径是 /api/hongniaoai/v1/models，直接提取 v1/models
  if (!targetPath && eventPath.includes('/api/hongniaoai/')) {
    targetPath = eventPath.split('/api/hongniaoai/')[1] || '';
  }

  // 如果还是为空，返回错误
  if (!targetPath) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({
        error: 'Missing path',
        eventPath: eventPath,
        queryParams: queryParams
      }),
    };
  }

  // 构建目标 URL
  const targetUrl = `https://open.hongniaoai.com/api/${targetPath}`;

  console.log('目标路径:', targetPath);
  console.log('目标URL:', targetUrl);

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

    // 发送请求
    const response = await fetch(targetUrl, fetchOptions);
    const data = await response.json();

    console.log('响应状态:', response.status);

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