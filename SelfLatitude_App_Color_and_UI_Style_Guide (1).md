**PRODUCT DESIGN SPECIFICATION**

**SelfLatitude Companion**

App Color and UI Style Guide

| Audience | Product designers and developers building the Companion web application |
| :---- | :---- |
| **Direction** | Modern editorial technology: clean software surfaces with selective SelfLatitude warmth |
| **Default theme** | Light mode for the MVP; dark mode is optional future scope |

| Core visual rule Use white and cool off-white to define the application. Use slate and charcoal for navigation, actions, and hierarchy. Reserve warm ivory for reflection, course prompts, and journal moments. The app should feel like modern software that belongs to SelfLatitude, not like the course slides placed inside a browser. |
| :---- |

# **1\. Visual Direction**

The recommended system is a cleaner, cooler extension of the existing SelfLatitude identity. It preserves the calm editorial tone while increasing contrast, clarity, and product usability.

* Approximately 70% white and cool off-white surfaces.  
* Approximately 20% charcoal and slate for structure, text, controls, and navigation.  
* Approximately 10% warm ivory and restrained status colors for meaningful emphasis.  
* Use generous whitespace, thin dividers, restrained rounded corners, and minimal shadows.  
* Avoid making every screen beige; that will make the product feel dated and reduce interface clarity.

# **2\. Core App Palette**

|  | Token / role | Hex | Developer use |
| :---- | :---- | :---- | :---- |
|  | **App background** | \#F6F8F9 | Primary page background behind chat, settings, memory, and administration. |
|  | **Surface / card** | \#FFFFFF | Conversation canvas, editor page, cards, menus, and modal surfaces. |
|  | **Warm branded surface** | \#F8F1ED | Reflection prompts, course exercises, selected journal moments, and onboarding accents. |
|  | **Primary text** | \#282725 | Headings, primary body copy, navigation labels, and the ‘Self’ portion of the logo. |
|  | **Secondary text** | \#66747B | Supporting labels, timestamps, metadata, and descriptions. |
|  | **Primary action** | \#405F73 | Primary buttons, strong links, selected controls, and major interactive emphasis. |
|  | **Secondary brand** | \#5F7F96 | Icons, secondary actions, links, and the ‘Latitude’ portion of the logo. |
|  | **Pale slate surface** | \#EAF0F3 | Student chat bubbles, memory labels, information cards, and subtle grouping. |
|  | **Border / divider** | \#DCE3E6 | Dividers, input borders, card outlines, table rules, and inactive controls. |
|  | **Selected / hover** | \#DDE8ED | Active conversations, hovered navigation, selected models, and response-depth controls. |
|  | **Focus ring** | \#8FAABA | Keyboard focus outline around links, inputs, buttons, and interactive cards. |

# **3\. Functional Colors**

|  | Token / role | Hex | Developer use |
| :---- | :---- | :---- | :---- |
|  | **Success / confirmed** | \#3F7867 | Approved memory, successful API-key test, saved settings, and active status. |
|  | **Success background** | \#E8F2EE | Background behind success messages and confirmed states. |
|  | **Warning / usage low** | \#A66F2C | Usage warnings, pending review, and actions requiring attention. |
|  | **Warning background** | \#FAF0DF | Background behind usage warnings and non-destructive cautions. |
|  | **Error / destructive** | \#B65050 | Failed key, validation error, deletion, suspension, and destructive confirmation. |
|  | **Error background** | \#F9EAEA | Background behind error messages and destructive warnings. |
|  | **Information** | \#4E7187 | Helpful system explanations, neutral notices, and progress information. |
|  | **Information background** | \#E9F1F5 | Background behind neutral information and educational notices. |

# **4\. Area-by-Area Color Recipes**

## **Chat**

The chat should feel open, clean, and contemporary rather than like a collection of heavy message bubbles.

* Use \#F6F8F9 behind the conversation and \#FFFFFF for the primary conversation surface.  
* Assistant responses may sit directly on the white surface. Use \#EAF0F3 for student messages.  
* Use \#405F73 for Send and other primary actions; use \#DDE8ED for selected model and response-depth controls.  
* Keep references, timestamps, and secondary controls in \#66747B.

## **Sidebar and navigation**

Navigation should be quiet enough that the conversation remains primary.

* Use \#F1F4F5 as the sidebar background and \#DDE8ED for the active conversation.  
* Use \#282725 for important labels, \#66747B for metadata, and \#DCE3E6 for dividers.  
* Use outline icons in \#5F7F96; avoid multicolored navigation icons.

## **Journal**

The journal is the warmest part of the product and should connect most directly to the Foundations course.

* Use \#FBF8F5 or \#F8F1ED around the editor, with a white writing page.  
* Use \#5F7F96 for the selected calendar date and \#F8F1ED for course-prompt cards.  
* Do not automatically send journal content to the Companion; visual styling should reinforce that it is private.

## **Memory**

Memory should feel transparent, controllable, and clearly user-approved.

* Use white cards on \#F6F8F9, with category chips in \#EAF0F3.  
* Use \#3F7867 only for confirmed memories and \#A66F2C for pending approval.  
* Place Edit, Disable, and Delete controls consistently; destructive actions use \#B65050 only when activated.

## **Owner Configuration and Super Admin**

Administrative screens should be more utilitarian than the student experience.

* Use white surfaces on \#F6F8F9 with slate navigation and minimal ivory.  
* Reserve red for destructive or failed states, not ordinary emphasis.  
* Use tables sparingly and retain generous row height, clear labels, and visible keyboard focus.

# **5\. Component Specifications**

| Component | Default | Hover / focus | Implementation note |
| :---- | :---- | :---- | :---- |
| **Primary button** | \#405F73 | \#334E60 | White text; use for the single primary action in a view. |
| **Secondary button** | \#FFFFFF | \#EAF0F3 | Deep-slate text and a \#DCE3E6 border. |
| **Destructive button** | \#B65050 | Darker red | Use only after the user initiates a destructive action. |
| **Disabled control** | \#BCC8CE | No hover | Do not rely on opacity alone; keep labels legible. |
| **Text input** | \#FFFFFF | \#DDE8ED | Default border \#DCE3E6; focus ring \#8FAABA. |
| **Student message** | \#EAF0F3 | N/A | Rounded but restrained; avoid oversized bubble padding. |
| **Assistant response** | \#FFFFFF | N/A | Prefer an open reading surface without a strong container. |
| **Active navigation** | \#DDE8ED | \#D4E1E7 | Deep-slate label with a subtle selected indicator. |
| **Modal / menu** | \#FFFFFF | N/A | Fine \#DCE3E6 border and a very light shadow only when needed. |

# **6\. Typography**

| Modern product typography Use Inter as the first-choice interface font. Montserrat is an acceptable brand-aligned alternative. Use Baskerville only for the logo, onboarding headlines, major empty states, and selected journal or course prompts. Do not use Baskerville for chat text, buttons, forms, settings, or administration. |
| :---- |

| Role | Typeface | Size | Weight | Use |
| :---- | :---- | :---- | :---- | :---- |
| **Display / onboarding** | Baskerville | 30-40 px | Regular | Brand-led moments only |
| **Page title** | Inter | 24-28 px | 600 | Primary screen heading |
| **Section heading** | Inter | 18-20 px | 600 | Settings and content sections |
| **Body / chat** | Inter | 16 px | 400 | Line height approximately 1.5 |
| **Controls** | Inter | 14-15 px | 500-600 | Buttons, tabs, dropdowns |
| **Metadata** | Inter | 12-13 px | 400-500 | Dates, tokens, helper text |

# **7\. Shape, Spacing, and Elevation**

* Use an 8 px spacing system: 4 px for very small adjustments; then 8, 16, 24, 32, and 48 px.  
* Cards and modals: 12-16 px corner radius. Inputs and buttons: 8-10 px. Message bubbles: 14-18 px.  
* Prefer borders and background changes over heavy shadows. If elevation is necessary, use one subtle neutral shadow.  
* Use thin 1 px dividers and outline icons. Avoid glossy effects, dramatic gradients, glassmorphism, and ornamental animation.  
* Keep content widths comfortable for reading; do not stretch long chat or journal text across the entire desktop screen.

# **8\. Accessibility and Interaction Rules**

* Meet WCAG 2.2 AA contrast targets: at least 4.5:1 for ordinary text and 3:1 for large text and essential interface graphics.  
* Use \#405F73, not the lighter slate, for primary buttons and important small text on white.  
* Never use color as the only indicator of success, warning, error, approval, selection, or usage status. Add an icon and clear label.  
* Every interactive element must show a visible keyboard focus ring using \#8FAABA with sufficient separation from the control.  
* Touch targets should be at least 44 x 44 px where practical, especially on mobile.  
* Do not place low-contrast gray text on ivory or pale-slate backgrounds.  
* Respect reduced-motion preferences and avoid animations that imply the Companion is emotionally alive or continuously monitoring the user.

# **9\. Developer Color Tokens**

Use semantic token names in the application rather than scattering raw hex values through individual components. The following can be used as the starting light-theme variables.

| :root {  \--sl-bg-app: \#F6F8F9;  \--sl-surface: \#FFFFFF;  \--sl-surface-warm: \#F8F1ED;  \--sl-text-primary: \#282725;  \--sl-text-secondary: \#66747B;  \--sl-action-primary: \#405F73;  \--sl-action-primary-hover: \#334E60;  \--sl-brand-secondary: \#5F7F96;  \--sl-surface-subtle: \#EAF0F3;  \--sl-border: \#DCE3E6;  \--sl-selected: \#DDE8ED;  \--sl-focus: \#8FAABA;  \--sl-success: \#3F7867;  \--sl-success-bg: \#E8F2EE;  \--sl-warning: \#A66F2C;  \--sl-warning-bg: \#FAF0DF;  \--sl-error: \#B65050;  \--sl-error-bg: \#F9EAEA;  \--sl-info: \#4E7187;  \--sl-info-bg: \#E9F1F5;} |
| :---- |

# **10\. MVP Design Acceptance Checklist**

* The app uses \#F6F8F9 and white as its dominant surfaces; ivory is reserved for reflective or course-related moments.  
* Primary actions consistently use deep slate and remain readable in normal, hover, disabled, and focus states.  
* Chat, journal, memory, owner configuration, and Super Admin each follow the area recipes in this guide.  
* Baskerville appears selectively; the functional interface uses Inter or Montserrat.  
* All status states include text or icons in addition to color.  
* Keyboard focus is visible throughout, and responsive touch targets are usable on mobile.  
* The interface avoids heavy beige coverage, glossy effects, dramatic gradients, and large shadows.  
* The final product feels like contemporary AI software while remaining recognizably SelfLatitude.