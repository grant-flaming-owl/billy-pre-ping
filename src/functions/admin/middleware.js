function requireAdminKey(request) {
  const key = request.headers.get('x-admin-key');
  if (!key || key !== process.env.ADMIN_API_KEY) {
    return {
      status: 401,
      headers: { 'Content-Type': 'application/json', ...corsHeaders() },
      body: JSON.stringify({ error: 'unauthorized' }),
    };
  }
  return null;
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-admin-key',
  };
}

module.exports = { requireAdminKey, corsHeaders };
