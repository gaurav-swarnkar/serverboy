// Swagger UI (served from node_modules/swagger-ui-dist at /vendor/swagger-ui) for the
// OpenAPI description of a Data API service.
let loading = null;

function loadSwagger() {
  if (window.SwaggerUIBundle) return Promise.resolve();
  if (!loading) {
    loading = new Promise((resolve, reject) => {
      const css = document.createElement('link');
      css.rel = 'stylesheet';
      css.href = '/vendor/swagger-ui/swagger-ui.css';
      document.head.append(css);
      const js = document.createElement('script');
      js.src = '/vendor/swagger-ui/swagger-ui-bundle.js';
      js.onload = resolve;
      js.onerror = () => reject(new Error('Could not load Swagger UI'));
      document.head.append(js);
    });
  }
  return loading;
}

export async function mountSwagger(el, specUrl) {
  await loadSwagger();
  el.innerHTML = '';
  window.SwaggerUIBundle({
    url: specUrl,
    domNode: el,
    deepLinking: false,
    docExpansion: 'list',
    defaultModelsExpandDepth: 0,
    persistAuthorization: true,
    // "Try it out" through Serverboy needs Serverboy's request header (CSRF protection).
    requestInterceptor: (req) => {
      if (new URL(req.url, location.href).origin === location.origin) req.headers['x-serverboy'] = '1';
      return req;
    },
  });
}
