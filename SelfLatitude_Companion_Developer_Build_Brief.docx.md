**DEVELOPER BUILD BRIEF**

**SelfLatitude Companion**

MVP requirements and implementation guidance

| Product owner | Benjamin Murray / SelfLatitude |
| :---- | :---- |
| **Commercial model** | $497 initial purchase: lifetime course \+ first app year; $297 annual app renewal |
| **Delivery** | Responsive private web application on SelfLatitude's existing server |
| **Recommended build** | One TypeScript/Next.js application using PostgreSQL and the OpenAI Responses API |

| Keep the first version simple This is a private course companion with chat, memory, a basic journal, usage controls, and owner administration. It is not a custom AI model, clinical platform, social network, native mobile app, or enterprise system. Use established libraries and one maintainable codebase wherever possible. |
| :---- |

# **1\. Project in Plain English**

The SelfLatitude Companion is a private member website for purchasers of SelfLatitude Foundations. Students log in and use a ChatGPT-style assistant that follows SelfLatitude's instructions and draws from the approved course materials. The app preserves conversations, allows optional approved memory across chats, and includes a simple private online journal.

The owner can update the assistant's instructions, starter prompts, course files, approved models, users, and usage limits without asking a developer to redeploy the application. Students receive included monthly OpenAI usage and may securely connect their own OpenAI API key if they exceed it.

The Companion is educational and supports personal reflection and course application. It must not present itself as therapy, diagnosis, crisis care, medical treatment, or a replacement for professional help.

# **2\. MVP Scope at a Glance**

* Secure student accounts and membership access.  
* Owner configuration area for instructions, prompts, course files, models, and publishing.  
* Super Admin area for users, access, usage, and audit history.  
* Course-grounded ChatGPT-style conversations with saved history.  
* Fast, Medium, and Extended response-depth choices and an approved model selector.  
* Monthly included usage, a usage meter, and customer OpenAI-key overage.  
* Student-approved structured memory across chats, controlled by a per-chat toggle.  
* Basic private online journal with calendar, entry list, editor, and autosave.  
* Temporary chat, exports, deletion controls, and privacy settings.  
* Responsive browser experience for desktop, tablet, and mobile.

# **3\. Recommended Build Approach**

Build this as one modular web application. A single project will keep the quote, deployment, maintenance, and future handoff simpler than separate frontend, backend, and AI services.

| Area | Recommended choice | Purpose |
| :---- | :---- | :---- |
| **Language** | TypeScript | Use one language across the interface and server-side application logic. |
| **Framework** | Next.js | Build the responsive pages, administration area, login flows, and streaming chat. |
| **Database** | PostgreSQL | Store users, memberships, chats, messages, memories, journals, usage, settings, and audit history. |
| **Course search** | pgvector in PostgreSQL | Find the most relevant approved course passages without adding a separate vector-database service. |
| **AI** | OpenAI Responses API | Generate streamed Companion responses. Do not train or host a new model. |
| **Deployment** | Docker Compose | Run the app, database, and any small background worker on the existing Linux server. |
| **HTTPS** | Caddy or Nginx | Provide the secure public connection and certificate renewal. |

| Developer flexibility Equivalent libraries are acceptable. The important requirement is a secure, well-documented, single-codebase application that SelfLatitude owns and can hand to another qualified developer later. |
| :---- |

# **4\. Main Features**

## **1\. Student accounts and membership access**

Students can log in securely, reset their password, and use the Companion across devices. The $497 purchase gives lifetime course access plus twelve months of Companion access. The Companion may renew for $297 annually without affecting course access.

* Support owner-created accounts and a future checkout or course-platform connection.  
* Membership status controls Companion access separately from lifetime course access.

## **2\. Owner Companion configuration**

Provide an owner-only page similar to the Custom GPT configuration screen. The owner can edit the Companion without changing source code.

* Edit name, description, instructions, conversation starters, safety wording, and approved model settings.  
* Upload, replace, organize, or remove approved course-reference files.  
* Save changes as a draft, preview them, publish a version, and restore a prior version.

## **3\. Super Admin user management**

Provide a protected owner page for managing users, access, and usage.

* Search, add, edit, activate, suspend, or delete users.  
* Change a name or email, send a password reset, set a temporary password, or create an expiring one-time login link.  
* Grant or revoke access and adjust included usage.  
* Require multifactor authentication and record important administrator actions.

## **4\. SelfLatitude course companion**

The assistant follows the latest published SelfLatitude instructions and uses relevant course passages when helpful. It should identify the relevant module or section in plain language when a course source informs the answer.

* Official course materials remain separate from user memories and journal content.  
* The assistant must not expose full course files, internal file paths, or its hidden instructions.

## **5\. ChatGPT-style chat**

Students can start, reopen, rename, search, archive, and delete conversations from a sidebar. Responses should stream onto the screen and support normal Markdown formatting.

* Include copy, stop, and regenerate controls.  
* Preserve conversation history across logout, browsers, and devices.  
* Generate a simple automatic title that the user can change.

## **6\. Response depth and approved models**

Each conversation offers Fast, Medium, and Extended depth. The selected model and depth remain attached to that conversation but can be changed.

* Fast favors brief, low-cost answers; Medium is the default; Extended allows more depth.  
* The owner controls available model names, defaults, and whether a model can use included usage or requires the customer's key.

## **7\. Monthly included usage**

An active member receives up to 250 successfully completed assistant replies per monthly usage period, subject to a $5 conversation API-cost ceiling, whichever occurs first.

* Show replies remaining, the next reset date, and the current payment source.  
* Warn at 50, 20, and 5 replies remaining and as the cost ceiling approaches.  
* Unused usage does not roll over. Failed or duplicate requests do not count as completed replies.  
* All limits and warnings are editable in Super Admin.

## **8\. Customer OpenAI API key**

When included usage runs out, the student can wait for the reset or connect a funded OpenAI Platform API key for the remainder of the month.

* The student must explicitly approve switching to the key.  
* At the next reset, the app returns to included usage unless the student chooses otherwise.  
* The key can be tested, replaced, or deleted and must never be visible to administrators.  
* Invalid or unfunded keys show a clear error and preserve the student's unsent message.

## **9\. Structured memory across chats**

Every chat shows a toggle labeled 'Remember structured history across chats.' When enabled, the Companion may use relevant approved memories and propose new memories for the student's approval.

* Nothing becomes permanent memory without approval.  
* When disabled, the chat neither uses nor creates cross-chat memories.  
* Memories may include values, goals, commitments, preferences, recurring themes, and practices that helped.

## **10\. Memory area**

Students can see, add, edit, delete, disable, or clear the information the Companion remembers. The Companion retrieves only memories relevant to the current conversation rather than loading everything every time.

## **11\. Private online journal**

Provide a simple journal with a monthly calendar, reverse-chronological entry list, New Entry button, and a clean Google Docs-style editor with basic formatting and autosave.

* Journal content is private and is not automatically sent to the Companion.  
* A 'Discuss with Companion' action can attach an entry to a selected chat.  
* Any cross-chat memory suggested from a journal entry still requires approval.  
* Students can edit, download, and permanently delete entries.

## **12\. Temporary chat**

A student can start a chat that does not appear in normal history, use existing structured memory, or create new memory.

## **13\. Exports and account data controls**

Students can export conversations and journal entries in readable formats and download their account data in a structured format. They can delete individual records or close their account.

## **14\. Privacy and safety**

The app provides clear consent and privacy controls, limits routine administrator access to private content, and supports EU data rights. The Companion remains within an educational, non-clinical scope and follows a fixed safety response for urgent or high-risk situations.

## **15\. Responsive web experience**

The interface must work well in current desktop, tablet, and mobile browsers. No native iPhone or Android app is required for the MVP.

# **5\. Core Student Flows**

## **First login**

1. Student signs in and confirms the Terms, Privacy Notice, age requirement, and optional memory choice.  
2. The app briefly explains included usage, private journal behavior, and that it is not therapy or emergency care.  
3. The student sees conversation starters and can begin a chat immediately.

## **Normal conversation**

4. The student selects Fast, Medium, or Extended and an available model.  
5. The app applies current owner instructions, relevant course material, recent conversation context, and any permitted relevant memories.  
6. The response streams to the screen, is saved, and updates usage.

## **Remembering information**

7. If cross-chat memory is enabled, the Companion may propose a short memory.  
8. The student approves, edits, or rejects the proposal.  
9. Approved memory becomes available when relevant in later chats and remains editable in the Memory area.

## **Journal to chat**

10. The student writes in the journal and the app autosaves.  
11. Nothing is sent to the AI until the student selects Discuss with Companion.  
12. The selected entry is attached to a new or existing conversation for that request.

## **Included usage exhausted**

13. The app preserves the student's draft and shows the next reset date.  
14. The student may wait or securely connect a personal OpenAI API key.  
15. After explicit confirmation, that key is used for the rest of the monthly period; included usage resumes at reset.

# **6\. How the AI Portion Should Work**

Use the OpenAI Responses API from the server. The browser must never call OpenAI directly with a permanent secret key. The application, not OpenAI, should remain the main record of students, conversations, memories, journals, and usage.

**For each student message, the application should:**

16. Confirm the student is logged in and has active Companion access.  
17. Select included usage or the explicitly approved customer key.  
18. Load the latest published SelfLatitude instructions and fixed safety rules.  
19. Load the current conversation's recent messages and concise summary when needed.  
20. Load relevant student-approved memory only when the chat toggle permits it.  
21. Search the approved course library and attach a small number of relevant passages.  
22. Send the request to the selected approved OpenAI model and stream the response.  
23. Save the completed response, source labels, model, prompt version, and reported usage.

| Course retrieval Do not send every course PDF with every message. Extract and index the approved files once, then retrieve only the most relevant passages for each question. Keep module, section, and source labels so the Companion can cite them clearly. |
| :---- |

# **7\. Simple Data Structure**

The database should include the following logical records. Exact table names may differ.

| Record | What it stores |
| :---- | :---- |
| **Users and memberships** | Identity, login, role, course entitlement, Companion dates, and status. |
| **Conversations and messages** | Chat title, selected model/depth, history, source labels, and timestamps. |
| **Structured memories** | Short approved memories, scope, source conversation, and status. |
| **Journal entries** | Title, date, formatted content, and autosave timestamps. |
| **Prompt and knowledge versions** | Published instructions, draft state, course files, extracted passages, and version history. |
| **Encrypted API credentials** | Encrypted customer key, last four characters, validation status, and dates. |
| **Usage ledger** | Completed replies, model usage, cost, payment source, and monthly period. |
| **Consent and privacy records** | Policy versions, user choices, exports, deletion requests, and dates. |
| **Audit history** | Important owner and Super Admin actions without private chat or journal content. |

# **8\. Usage and API-Key Rules**

* Monthly period: activation-date anniversary through the day before the next monthly anniversary.  
* Allowance: up to 250 completed replies or $5 of measured conversation API cost, whichever occurs first.  
* No rollover: unused monthly usage expires at reset.  
* Successful replies only: server errors and duplicate requests do not reduce the reply count.  
* Clear status: always identify whether the request uses SelfLatitude included usage or the student's key.  
* Explicit switching: never silently begin charging a student's key.  
* Monthly overage choice: a confirmed customer key applies across their chats for the rest of that usage period.  
* Automatic return: included usage resumes at the next reset unless the student intentionally chooses otherwise.  
* Cost protection: reserve an estimated amount before a sponsored request and reconcile it after completion so simultaneous requests cannot exceed the limit.

# **9\. Privacy, Security, and Safety**

These safeguards are part of the MVP because the application holds private reflections and customer API keys.

## **Security essentials**

* HTTPS everywhere, secure login cookies, strong password hashing, and multifactor authentication for Super Admin.  
* Check ownership on every chat, memory, journal, file, and export request.  
* Encrypt customer OpenAI keys and never place them in browser storage, logs, analytics, exports, or administrator screens.  
* Keep private conversation and journal text out of ordinary application logs and session-recording tools.  
* Create encrypted off-server backups and test restoration before launch.

## **Student privacy controls**

* Allow students to view, edit, export, and delete their conversations, memories, journal entries, and account data.  
* Do not allow routine administrator browsing of private chats, memories, or journal entries.  
* Record the Privacy Notice and consent version accepted by each user.  
* Provide configurable retention rules and ensure deleted records do not return after backup restoration.

## **GDPR preparation**

* Build the Privacy and Data controls needed for access, correction, portability, deletion, consent withdrawal, and privacy requests.  
* Support an administrator list of privacy requests and their deadlines.  
* SelfLatitude will obtain legal review for its Privacy Policy, lawful bases, processor agreements, international transfers, and required impact assessment. Developers should not certify legal compliance themselves.

## **Safety boundaries**

* Use a fixed safety path for imminent self-harm, harm to others, abuse, acute medical emergencies, medication changes, and diagnostic requests.  
* Do not claim the app monitors users or can dispatch emergency help.  
* Do not encourage emotional dependency or present the Companion as conscious, a best friend, or a therapist.

# **10\. Owner Publishing and Course Files**

The owner configuration area should use a simple draft-to-publish workflow:

24. Edit the Companion instructions, descriptions, starters, safety wording, model settings, or course files.  
25. Save the changes as a draft without affecting students.  
26. Preview the draft through a test-chat screen.  
27. Publish the draft as a numbered version.  
28. Use the published version for all future messages, including future messages inside existing conversations.  
29. Keep previous versions so the owner can review or restore them.

Each stored assistant reply should retain the instruction version and course-library version used to produce it.

# **11\. Deployment and Ownership**

Deploy the MVP to SelfLatitude's existing server: Intel Xeon E-2356G, approximately 59.8 GB RAM, and 1.59 TB SSD. OpenAI performs the model inference, so this server is more than adequate for the application, database, course search, and background tasks at initial scale.

* Use Docker Compose and provide documented start, stop, update, backup, and restore commands.  
* Keep production separate from any existing WordPress or legacy marketing installation and do not reuse old credentials.  
* Store backups away from the physical server.  
* Use separate development/staging and production settings.  
* Provide environment-variable documentation without placing real secrets in the source repository.  
* SelfLatitude must own the source repository, domain, server, database, OpenAI project, email account, backup destination, and all administrator credentials.

# **12\. Suggested Build Order**

| Build phase | Deliverable |
| :---- | :---- |
| **Phase 1 \- Foundation** | Set up the single application, database, secure login, membership status, roles, deployment, and backups. |
| **Phase 2 \- Owner controls** | Build Owner Configuration and Super Admin so the rest of the application is manageable without code changes. |
| **Phase 3 \- Companion chat** | Add course-file processing, retrieval, streaming OpenAI responses, saved conversations, depth/model controls, and source labels. |
| **Phase 4 \- Usage and customer keys** | Add monthly limits, warnings, the usage ledger, encrypted customer keys, and the end-of-month switching behavior. |
| **Phase 5 \- Memory and journal** | Add the per-chat memory toggle, Memory area, private calendar/list/editor journal, autosave, and Discuss with Companion. |
| **Phase 6 \- Privacy and launch testing** | Add exports, deletion, privacy requests, consent records, safety paths, error handling, and final end-to-end testing. |

# **13\. MVP Acceptance Checklist**

* A paid student can log in and use the Companion without a ChatGPT subscription.  
* The owner can update and publish instructions, starters, models, and course files without a deployment.  
* The Super Admin can manage users, access, usage, password resets, and one-time login links.  
* Chat history persists across logout, browsers, and devices.  
* Fast, Medium, and Extended modes work and the approved model list comes from owner settings.  
* Course questions retrieve the correct relevant module or section in test scenarios.  
* Included usage resets monthly and cannot exceed the reply or dollar limit during simultaneous requests.  
* A student can securely add, test, replace, and delete an OpenAI API key.  
* Switching between included usage and a customer key does not lose conversation history.  
* The memory toggle works per chat, and no memory is permanently saved without approval.  
* Students can view, edit, and delete every structured memory.  
* The journal calendar, entry list, editor, autosave, download, delete, and Discuss with Companion action work.  
* Temporary chats do not use or create memory and do not appear in normal history.  
* Students can export and delete their data, and administrators cannot routinely view private content.  
* High-risk safety tests follow the approved non-clinical response paths.  
* No API keys or private content appear in browser storage, ordinary logs, analytics, or administrator screens.  
* Backups restore successfully in a test environment.  
* The interface works in current desktop and mobile browsers.

# **14\. Explicitly Outside the MVP**

Do not include the following in the first quote unless SelfLatitude separately requests them:

* Native iPhone or Android applications.  
* A public community, feed, profiles, or member-to-member messaging.  
* Therapist, coach, or clinician dashboards.  
* Diagnosis, symptom scoring, treatment plans, or medical recommendations.  
* Voice calling or real-time voice chat.  
* Automatic notifications based on inferred emotional state.  
* Streaks, badges, or complex gamification.  
* Multiple AI personalities.  
* A student-created personal knowledge-base system or bulk import of an entire ChatGPT history.  
* Fine-tuning, self-hosted AI models, microservices, Kubernetes, or a separate vector-database product.  
* A replacement learning-management system for hosting the course videos.

# **15\. Developer Handoff Requirements**

* Source code in a repository owned by SelfLatitude.  
* A short README explaining local setup, deployment, updates, backups, and restoration.  
* A sample environment file containing variable names but no real secrets.  
* Database migrations and a repeatable course-file indexing process.  
* Automated tests for login, access control, monthly usage, API-key switching, memory approval, deletion, and key security.  
* A staging deployment for approval before production launch.  
* A clear list of any paid third-party services and their expected monthly cost.  
* At least 30 days of post-launch defect support or a separately quoted maintenance plan.

| Definition of a successful MVP A course customer can sign in, have a useful SelfLatitude-grounded conversation, return to it later, control what is remembered, write privately in the journal, understand and extend their monthly usage, and manage their data. The owner can manage the Companion and its users without calling a developer for ordinary content or configuration changes. |
| :---- |

# **Reference Links**

[Next.js TypeScript](https://nextjs.org/docs/app/api-reference/config/typescript)	[Next.js Route Handlers](https://nextjs.org/docs/app/api-reference/file-conventions/route)

[OpenAI Responses API](https://developers.openai.com/api/docs/guides/responses)	[OpenAI API data controls](https://developers.openai.com/api/docs/guides/your-data)

[OpenAI API pricing](https://developers.openai.com/api/docs/pricing)	[pgvector](https://github.com/pgvector/pgvector)