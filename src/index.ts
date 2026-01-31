export default {
  async fetch(request) {
    return new Response("Hello World!");
  },
} satisfies ExportedHandler<Env>;
