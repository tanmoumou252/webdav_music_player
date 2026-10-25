export function onRequest(context) {
  return handleRequest(context.request, context.env);
}
