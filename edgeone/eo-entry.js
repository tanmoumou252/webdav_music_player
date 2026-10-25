export default async function onRequest(context) {
  return handleRequest(context.request, buildEnv(context));
}
