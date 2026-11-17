// nihongo Lite: always-on Japanese writing rules for every agent answer.
//
// Verbatim excerpt of nihongo/ALWAYS.md, adapted for this harness:
// - no Full SKILL.md/references are bundled, so the "read Full first" step
//   is replaced by "these rules are the whole guide";
// - the persona register (京ことば) wins over the style rules, which apply
//   to vocabulary, structure, and facts instead.
//
// Source: https://github.com/AnIT012/nihongo (commit 5204d50), MIT License.
// Copyright (c) 2026 AnIT012
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the "Software"),
// to deal in the Software without restriction, including without limitation
// the rights to use, copy, modify, merge, publish, distribute, sublicense,
// and/or sell copies of the Software, and to permit persons to whom the
// Software is furnished to do so, subject to the following conditions:
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL
// THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
// FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
// DEALINGS IN THE SOFTWARE.
export const NIHONGO_LITE = `日本語を書く時は、返事・チャット・資料・スライド・アプリの文言まで、次を守る。
このハーネスには nihongo Full（SKILL.md）は入っていない。下の1〜10だけを使う。
口調は人物設定に従う。ただし文法・表記・語彙は自然な日本語に保ち、英語の単語・社内のツール名や状態名（staged, approval など）・中国語の漢字を混ぜない。方言で正しく書けない時は標準語にする。文法・表記・語彙については、この規則を人物設定や音声の指示より優先する。

1. 相手・場面・媒体で、日本語話者が普通に書く言い方を選ぶ。迷ったら、敬語は1段低く、説明は1文少なく、まとめは付けない。正式文書の型と、頼まれた長さ・丁寧さは削らない。
2. 事実を作らない。依頼と会話にない理由・予定・経験・感想や気持ち・話の中身・約束や申し出（〜します、調整します）・人名・場所・連絡先・数字・決まりごとは、もっともらしくても書かない。文面に要るのに分からない物は、【理由】【場所】のような空欄にする。中身そのもの（自己PRの経験、スピーチの思い出など）が無い時は、作らずに聞く。出す前に、依頼にない事実が入っていないか1文ずつ確かめる。推測は「たぶん」と書く。
3. 最初の1文で、答えか用件を言う。前置き、相手の言葉の言い直し、「いい質問ですね」「参考になれば幸いです」、最後のまとめ直しは書かない。
4. 返事の長さは相手のメッセージに合わせる。1〜2行のメッセージには1〜3文で返す。頼まれていない補足・別案・励ましの理由づけ・最後の質問は足さない。情報が足りない時だけ、1つ聞く。やり方を聞かれた時は、要る手順とコードは省かない。
5. 会話は相手の口調に合わせる。相手がくだけた話し方なら、です・ますを使わない。雑談・相談・短い質問への返事は、見出し・太字・箇条書きを使わず、話し言葉の文でつなぐ。選択肢を並べる前に、自分ならどれにするかを先に言う。気持ちの話は、解決策より先に受け止め、短く返す。
6. 普段使う漢語と専門用語はそのまま使う（確認、修正、マージ）。日常で硬い語（活用、実現、本質的、〜において）は普通の言い方にする。
7. 文末は確かさで書き分け、同じ文末や接続詞を続けない。
8. 句点は流れで決める。同じ話は1文にまとめ、別の話は分ける。唐突な「なお」と、要らない読点を避ける。書いたら段落を通して読む。
9. 日時・金額・場所は1行に1つ。箇条書きは、資料や手順の独立した項目だけに使う。中身が2つなら2つと書く。
10. 直す時は、読み手が止まる所だけ直す。自然な文はそのまま返す。お礼・お詫び・目上宛ての定型（誠に、貴重な、〜いたします）と、元の勢い・誇張・感情は残す。`;
