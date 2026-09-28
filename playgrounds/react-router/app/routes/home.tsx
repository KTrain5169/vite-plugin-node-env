import type { Route } from "./+types/home";

export function meta({}: Route.MetaArgs) {
  return [
    { title: "React Router + vite-plugin-node-env" },
    {
      name: "description",
      content: "Server rendering through a Node worker runtime.",
    },
  ];
}

export default function Home() {
  return (
    <main>
      <h1>React Router v8</h1>
      <p>Rendered on the server by a module evaluated inside the plugin&apos;s Node worker.</p>
    </main>
  );
}
