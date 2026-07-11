# Moderation transparency

This page explains how SMARCH moderates public project signs and uploaded images, including blocked content, reports, and appeals. Project owners, contributors, and moderators should read it before publishing or reviewing public content. Return to it when a submission is rejected or a report needs follow-up. Remember that uncertain or failed moderation checks keep content private until review.

Every project sign (text + link) and every uploaded image in the SMARCH space is
AI-moderated before it becomes public. Moderation is fail-closed: if the check errors or
is uncertain, the content is not published.

## What gets blocked
Hate or harassment, sexual or NSFW content, violence or threats, illegal content, scams or
phishing, malware, doxxing or personal data, spam or gibberish, and links to malicious,
adult, or illegal sites.

## What is allowed
Legitimate project, company, portfolio, software, and business names, descriptions, and
links.

## How it works
Text is classified by a hosted model (fal.ai) that returns a safe/unsafe verdict with a
short reason; images pass an image-safety check. Approved content is stored and shown to
everyone; blocked submissions return the reason to the author and are never stored public.

## Appeals / reports
Anyone can report a build or sign; reported content is hidden pending human review. (Report
+ audit flows are on the roadmap - see `.UltraVision/tasks/moderate.jsonl`.)
