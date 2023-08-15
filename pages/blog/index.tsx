import Card from "../../components/card.tsx";
import type { PageProps } from "../../deps.ts";

import articles from "./_posts.json" assert { type: "json" };

export const config = {
  title: "Home",
  description:
    "Pyro was designed from the ground up to be no-config and incredibly fast.",
  hideNavbar: true,
};

const pinnedArticles = articles.filter((x) => x.isPinned);

export default function Page(props: PageProps) {
  return (
    <>
      {props.header}
      <div class="h-screen h-min-screen w-screen dark:bg-dark dark:text-light">
        <h1 class="py-2 text-4xl font-bold text-center">Blog!</h1>
        <main class="py-2 w-2/3 mx-auto">
          <div class="py-3">
            <h2 class="py-2 text-2xl font-bold text-center">
              Pinned Articles
            </h2>
            <div class="py-2 justify-center flex flex-wrap gap-x-2 gap-y-2">
              {pinnedArticles.map((x) => <Card {...x} />)}
            </div>
          </div>
          <div class="py-3">
            <h2 class="py-2 text-2xl font-bold text-center">
              All Articles
            </h2>
            <div class="py-2 justify-center flex flex-wrap gap-x-2 gap-y-2">
              {articles.map((x) => <Card {...x} />)}
            </div>
          </div>
        </main>
      </div>
      {props.footer}
    </>
  );
}
