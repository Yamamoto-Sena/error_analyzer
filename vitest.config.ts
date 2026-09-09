import { defineConfig } from "vitest/config";

// analyzer.ts / gemini.ts はDOMに依存しない純粋なロジックのため、
// 軽量な "node" 環境でテストする（jsdom等は不要）。
export default defineConfig({
  test: {
    environment: "node",
  },
});
