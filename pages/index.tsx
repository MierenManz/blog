import type { PageProps } from "../deps.ts";

export const config = {
  title: "Home",
  description: "The website of your favorite idiot!",
};

export default function Page(props: PageProps) {
  return (
    <>
      {props.header}
      <div class="h-screen h-min-screen w-screen bg-light dark:bg-dark dark:text-light">
        <h1 class="py-2 text-4xl font-bold text-center">
          The Website of your favorite idiot!
        </h1>
        <main class="py-2 w-4/6 mx-auto">
        </main>
      </div>
      {props.footer}
    </>
  );
}
