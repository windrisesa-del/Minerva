import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "Minerva",
    short_name: "Minerva",
    description: "Local AI teacher assistant",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#faf9f5",
    theme_color: "#cc785c",
    categories: ["education", "productivity"],
    lang: "en",
    icons: [
      {
        src: "/icons/icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icons/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
    ],
  };
}
