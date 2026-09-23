> **NOT LEGAL ADVICE — REVIEW REQUIRED BEFORE USE.**
> This document was drafted by an AI research assistant and has not been reviewed by a
> qualified lawyer. It cites statutes and deadlines that were not independently verified
> and that change frequently. Treat it as a starting checklist for a conversation with
> counsel in each hiring jurisdiction — not as a compliance sign-off. Do not publish or
> send any candidate-facing text from here until a lawyer has approved it.

> **Corrected against the code on 23 September 2026.** A legal review of the
> product found this document describing a Questor that does not exist: it said a
> voice recording is kept (none is — speech is transcribed live and only the text
> is stored), it offered a 30-day retention period (the default is 180 days), and
> it named OpenAI as the only third party (the model provider is configurable,
> and a candidate answering by voice in Chrome or Edge also sends audio to
> Google, which the live consent screen discloses and this document did not).
> Every one of those is corrected below, and marked where it mattered. The live
> product's own words are in `web/src/components/privacyModel.ts` and on the
> public `/privacy` page; where this document and the product disagree again,
> the product is what a candidate actually read.

# Questor: Candidate-Facing Legal Texts

This document contains four candidate-facing legal texts for the AI-driven first-round interview tool, **Questor**. These texts are designed to be short, legibly presented on-screen, written in plain English, and legally compliant with the GDPR (EU), DPDP Act (India), and AIVIA (Illinois, US).

---

## 1. AI Disclosure Notice (Pre-Interview)
*To be displayed to candidates on a dedicated landing page before starting the interview.*

> [!NOTE]
> ### About Your Interview with [Interviewer Name]
> 
> You are about to take a first-round interview for the **[Job Title]** role. This interview is conducted by **[Interviewer Name]** (Avery, Maya, Adrian, Elena or Theo), an AI interviewer from Questor, rather than a live person.
> 
> * **How it works:** You can answer questions using either voice or text. Your answers are transcribed as you speak. No audio recording of the interview is kept — the written transcript is what the hiring team reads.
> * **What it assesses:** The AI will evaluate your responses against a standard rubric for job-specific skills and competencies (such as **[Competency A]**, **[Competency B]**, and **[Competency C]**). It does **not** evaluate your body language, facial expressions, or voice tone.
> * **Humans make the decision:** Questor only provides an advisory score and recommendation. A human recruiter from **[Company Name]** will review this recommendation alongside your resume and make the final hiring decision.
> * **Your choices:** You do not have to use this AI tool. If you prefer to be interviewed by a human recruiter, or if you need an accommodation due to a disability, you can ask for an alternative on the consent screen itself — there is a box for it, and writing in it routes you to the hiring team instead of starting the AI interview — or by replying to your invitation email. Either way, at any time and without any negative impact on your application.
> * **What is not used:** There is no camera and no video anywhere in Questor. Nothing analyses your face, your body language or your tone of voice, and no facial recognition is used at any point.
> * **Where to read more:** The full privacy notice is at `/privacy`, linked from the consent screen before you agree to anything.

---

## 2. Explicit Consent Checkbox Text Block
*To be displayed at the bottom of the pre-interview page next to the start button. Candidates must check this box to proceed.*

[ ] **I consent to the AI-assisted interview process.** Specifically, I agree that:
1. My voice and/or text responses will be transcribed and evaluated by Questor's AI system to assess my job-related competencies as explained in the Disclosure Notice. No audio recording of the interview is kept; the written transcript is.
2. My interview data (the written transcript and the scores drawn from it) will be processed by **[Company Name]** and sent to the AI model provider it has configured — **[Model Provider]** — for the sole purpose of conducting and scoring the interview.
3. If I answer by speaking, my microphone audio is sent, while I speak, to my browser's own speech recognition so that it can be turned into text — in Chrome and Edge that means Google's servers — and, where **[Company Name]** has configured a fallback, to **[Transcription Provider]**. If I type my answers instead, no audio leaves my device. No audio is kept by anyone afterwards.
4. A human recruiter will make the final hiring decision.
5. My consent is voluntary. I can leave the interview at any time, and one I leave is not scored and does not count against me. Afterwards I can ask **[Company Name]** for a copy of my interview data or for it to be deleted, by replying to my invitation email or writing to **[Contact Email/Link]**. I have read the **[Privacy Policy Link]** — in Questor that is the `/privacy` page, which every consent screen links to.

---

## 3. Data Rights Notice
*To be included in the privacy section of the interview portal or linked directly.*

> [!IMPORTANT]
> ### Your Data and Your Rights
> 
> We value your privacy. Here is how we handle your interview data and how you can control it:
> 
> #### What Data We Hold
> * The written transcript of your answers. **No audio recording is kept** — your
>   voice is turned into text as you speak and each clip is discarded once the text
>   comes back, so there is no recording of your voice for anyone to listen to
>   later. (This document previously said a voice recording is held. It never was.)
> * The text of your CV, where one was uploaded. The file itself is read and discarded.
> * The scores and competency evaluations generated by the Questor AI, with the
>   passages of your transcript quoted as the evidence for each one.
> * The record of what you were shown before you consented and what you agreed to,
>   and any accommodation you asked for.
> 
> #### How Long We Keep It
> We keep your interview and everything attached to it for **180 days by default**,
> counted from when the interview finished, unless **[Company Name]** has set a
> different window. Two honest qualifications: deletion on that schedule happens
> only where **[Company Name]** has switched the automatic sweep on, and where a
> legal hold has been placed on an interview, deletion waits until the hold is
> lifted. (This document previously offered 30 days, which is not the default.)
> 
> #### Your Rights
> Depending on where you live, you have the following legal rights (under the EU GDPR Articles 15 & 17, India DPDP Act Section 8, and Illinois AIVIA):
> * **Right to Access (GDPR Art. 15 / DPDP Sec. 8):** You can ask for a copy of your interview transcript, AI scores, and recommendations.
> * **Right to Deletion (GDPR Art. 17 / DPDP Sec. 8 / Illinois AIVIA):** You can request that we delete all your interview data. Questor holds no video and no audio recording to delete — there is none at any point — so what is deleted is the transcript, the CV text, the assessment and the rest of the record. A request is refused only while a legal hold stands on the interview, and you are told when that is the reason.
> * **Right to Correction (GDPR Art. 16 / DPDP Sec. 8):** You can request that we correct errors in your contact details or transcript.
> 
> **How to exercise your rights:**
> Ask **[Company Name]** — the organisation that invited you. It decides what happens
> to your data, and its administrators can produce or erase it in Questor. The
> quickest route is to reply to the email your invitation came in. To file a
> complaint, or if you cannot reach them, write to **[Contact Email/Link]**; you may
> also complain to your own data protection regulator. We will respond within
> **[Timeframe, e.g., 30 days]** at no cost to you.

---

## 4. Explanation-of-Decision Template
*A template for recruiters to send if a candidate requests an explanation of their AI assessment (satisfying EU AI Act Article 86).*

### Template Metadata
* **Recipient:** Candidates requesting AI feedback
* **Applicability:** EU AI Act compliance (Article 86 right to an explanation of AI-assisted decision making)

```markdown
Subject: Explanation of AI Interview Assessment for the [Job Title] position

Dear [Candidate Name],

Thank you for your interest in the [Job Title] role at [Company Name] and for completing your first-round interview on [Date of Interview]. 

You recently requested information regarding how the Questor AI assistant evaluated your interview. As part of our commitment to transparency, we are pleased to share how the system was used, the criteria assessed, and the input data processed.

### 1. Role of the AI System in the Decision
Questor is used solely as an advisory screening tool during our first-round stage. The AI conducts the interview, transcribes the responses, and scores specific competencies against a pre-set rubric. The AI does not make hiring decisions. The final decision to advance or reject an application is made entirely by a human recruiter, who reviews the AI's recommendations alongside your resume.

### 2. Input Data Used
The system evaluated only the following data:
- The text transcript of your answers to the interview questions.
- The text of your CV, where one was uploaded.
No audio recording of your answers exists — your voice was turned into text as you spoke and each clip discarded. No external data, personal background, or physical characteristics (like body language, facial expressions or tone of voice) were analysed, and no camera was used.

### 3. Competencies Assessed & Main Parameters
Your responses were scored against a rubric for these core competencies:
1. **[Competency 1, e.g., Technical Problem Solving]:** Assessed by your ability to explain logical debugging steps in Question [X].
2. **[Competency 2, e.g., Collaboration]:** Assessed by your description of how you resolved team conflict in Question [Y].
3. **[Competency 3, e.g., Communication]:** Assessed by how clearly and concisely you structured your answers.

### 4. Evaluation Summary
- **AI Recommendation:** [Insert AI outcome, e.g., Recommended / Not Recommended / Borderline]
- **AI Assessment Notes:** [Insert brief summary of AI output, e.g., "The system noted strong technical problem-solving skills with detailed examples, but identified a lack of specific details regarding collaborative actions in the teamwork scenario."]
- **Human Recruiter Decision:** [Insert human decision context, e.g., "Our recruiting team reviewed these results. While your technical skills are strong, we decided not to move forward with your application because we are prioritizing candidates with more direct experience in cross-functional team leadership as discussed in Question Y."]

If you have any further questions or would like to request a manual review of your transcript by a senior recruiter, please reply directly to this email or contact us at [Contact Email].

Sincerely,

[Recruiter Name]  
[Company Name]  
```
