// SPDX-License-Identifier: MPL-2.0

/**
 * Regression (run #10 D3, searchviu migration): imported blog bodies
 * carried the source's full WordPress comment threads (90+ comments
 * per post), bloating composed pages and blowing rebuild-subagent
 * context windows. Comment threads must be stripped at extraction and
 * the removal must be COUNTED loudly, never silent.
 */

import { describe, expect, it } from "bun:test";
import { extractModulesFromHtml, stripCommentThreads } from "./extractor.js";

/** Realistic WP theme markup: comments area + threaded list + reply form. */
const WP_COMMENTS = `
<div id="comments" class="comments-area">
  <h2 class="comments-title">93 thoughts on &ldquo;SEO Basics&rdquo;</h2>
  <ol class="comment-list">
    <li id="comment-101" class="comment even thread-even depth-1">
      <article class="comment-body">
        <footer class="comment-meta"><b class="fn">Alice</b></footer>
        <div class="comment-content"><p>Great article!</p></div>
        <a rel="nofollow" class="comment-reply-link" href="?replytocom=101#respond">Reply</a>
      </article>
      <ol class="children">
        <li id="comment-102" class="comment odd alt depth-2">
          <article class="comment-body"><p>Thanks Alice.</p></article>
        </li>
      </ol>
    </li>
  </ol>
  <div id="respond" class="comment-respond">
    <h3 id="reply-title" class="comment-reply-title">Leave a Reply</h3>
    <form action="/wp-comments-post.php" method="post" id="commentform" class="comment-form">
      <textarea id="comment" name="comment"></textarea>
      <input name="submit" type="submit" value="Post Comment" />
    </form>
  </div>
</div>`;

/** Classic-theme variant: bare ol.commentlist + #respond outside it. */
const WP_CLASSIC_COMMENTS = `
<ol class="commentlist">
  <li class="comment">old-school comment body</li>
</ol>
<div id="respond"><form id="commentform"><textarea></textarea></form></div>`;

describe("stripCommentThreads", () => {
  it("drops the full WP comments area (list + respond form) and counts it", () => {
    const html = `<article><p>Post body</p></article>${WP_COMMENTS}`;
    const out = stripCommentThreads(html);
    expect(out.html).not.toContain("Great article!");
    expect(out.html).not.toContain("Leave a Reply");
    expect(out.html).not.toContain("comment-list");
    expect(out.html).toContain("Post body");
    // The whole thread is ONE matched subtree (#comments wraps it all).
    expect(out.removed).toBe(1);
  });

  it("drops classic-theme ol.commentlist and #respond as separate subtrees", () => {
    const html = `<div class="entry-content"><p>keep</p></div>${WP_CLASSIC_COMMENTS}`;
    const out = stripCommentThreads(html);
    expect(out.html).not.toContain("old-school comment body");
    expect(out.html).not.toContain("commentform");
    expect(out.html).toContain("keep");
    expect(out.removed).toBe(2);
  });

  it("drops page-builder comment widgets (Elementor / Divi / Avada / block editor / Disqus)", () => {
    for (const marker of [
      '<div class="elementor-widget-post-comments">builder-thread</div>',
      '<div class="et_pb_comments_0 et_pb_comments">builder-thread</div>',
      '<div class="fusion-comments">builder-thread</div>',
      '<div class="wp-block-comments">builder-thread</div>',
      '<div id="disqus_thread">builder-thread</div>',
    ]) {
      const out = stripCommentThreads(`<p>keep</p>${marker}`);
      expect(out.html).not.toContain("builder-thread");
      expect(out.html).toContain("keep");
      expect(out.removed).toBe(1);
    }
  });

  it("keeps prose that merely talks about comments (and unrelated class tokens)", () => {
    const html =
      '<article class="commentary-piece"><h1>How to moderate comments</h1>' +
      "<p>Readers left 90 comments on our respond-to-feedback policy.</p></article>";
    const out = stripCommentThreads(html);
    expect(out.html).toBe(html);
    expect(out.removed).toBe(0);
  });

  it("is applied by extractModulesFromHtml and surfaces the count", () => {
    const html = `<html><body><header>H</header><main><p>Content</p>${WP_COMMENTS}</main><footer>F</footer></body></html>`;
    const { modules, commentsStripped } = extractModulesFromHtml(html);
    const all = modules.map((m) => m.html).join("");
    expect(all).not.toContain("Great article!");
    expect(all).toContain("Content");
    expect(commentsStripped).toBe(1);
  });
});
