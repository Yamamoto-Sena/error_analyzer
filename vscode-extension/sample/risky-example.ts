// この拡張機能の動作確認用サンプルです。
// 拡張機能を実行した状態でこのファイルを開くと、下の `items.map(` の部分に
// 赤波線（Diagnostics）が表示されます。

async function fetchItems(): Promise<{ name: string }[] | undefined> {
  const response = await fetch('/api/items');
  if (!response.ok) {
    return undefined;
  }
  return response.json();
}

async function renderItems() {
  const items = await fetchItems();

  // items が undefined の可能性があるのに、そのまま .map() を呼んでいる
  // → 赤波線が表示され、ホバーで説明、電球マークで Quick Fix (?.map に変換) が出るはず
  const names = items.map((item) => item.name);

  console.log(names);
}
