console.log("SERVER RESTARTED WITH NEW CODE");
require('dotenv').config();
const express = require("express");
const { v4: uuidv4 } = require("uuid");
const cors = require("cors");

const Anthropic = require("@anthropic-ai/sdk");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json({ limit: "2mb" }));

const CANDIDATES = JSON.parse(
  fs.readFileSync(path.join(__dirname, "candidates.json"), "utf-8")
);

const jobs = {};

function getClient(apiKey) {
  return new Anthropic({ apiKey });
}

async function callClaude(client, system, userMessage, maxTokens = 1000) {
  const response = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content: userMessage }],
  });
  return response.content[0].text.trim();
}

function safeParseJSON(text) {
  const clean = text.replace(/```json|```/g, "").trim();
  return JSON.parse(clean);
}

async function parseJD(rawJD, client) {
  const system = `You are an expert HR analyst. Extract all relevant information from job descriptions.
Return ONLY a valid JSON object — no markdown, no explanation, no code fences.`;

  const schema = {
    job_title: "string",
    company: "string",
    required_skills: ["array of strings"],
    preferred_skills: ["array of strings"],
    experience_level: "intern|junior|mid|senior|lead|principal|director",
    years_min: "integer",
    years_max: "integer",
    education_requirements: ["array of strings"],
    responsibilities: ["array of top 5-7 strings"],
    location: "string",
    remote_policy: "remote|hybrid|onsite",
    salary_min: "integer or null",
    salary_max: "integer or null",
    domain: "string e.g. fintech, saas, ecommerce",
    team_size: "string or null",
    key_differentiators: ["array of strings — what makes this role special"],
    inferred_culture: ["array of strings — cultural signals from language"],
  };

  const prompt = `Parse this job description and return JSON matching this schema exactly:
${JSON.stringify(schema, null, 2)}

JOB DESCRIPTION:
${rawJD}`;

  const raw = await callClaude(client, system, prompt, 2000);
  return safeParseJSON(raw);
}

function heuristicScore(jd, candidate) {
  let score = 0;
  const jdSkills = new Set(
    [...(jd.required_skills || []), ...(jd.preferred_skills || [])].map((s) =>
      s.toLowerCase()
    )
  );
  const candSkills = new Set(candidate.skills.map((s) => s.toLowerCase()));

  const overlap = [...jdSkills].filter((s) => candSkills.has(s)).length;
  score += (overlap / Math.max(jdSkills.size, 1)) * 50;

  const yoe = candidate.years_of_experience;
  if (yoe >= jd.years_min && yoe <= jd.years_max + 3) score += 20;
  else if (yoe < jd.years_min) score += Math.max(0, 10 - (jd.years_min - yoe) * 3);

  if (
    candidate.domain_experience.some((d) =>
      d.toLowerCase().includes(jd.domain?.toLowerCase() || "")
    )
  )
    score += 15;

  if (jd.remote_policy === "remote" || candidate.open_to_remote) score += 10;
  else if (candidate.location.toLowerCase().includes(jd.location?.toLowerCase() || ""))
    score += 10;

  // Availability bonus (max 5 pts)
  if (candidate.availability === "immediate") score += 5;

  return score;
}

async function scoreCandidate(jd, candidate, client) {
  const system = `You are a senior technical recruiter with 15+ years experience.
Evaluate candidate-JD fit honestly and precisely.
Return ONLY valid JSON — no markdown, no preamble.`;

  const schema = {
    match_score: "float 0.0-1.0",
    skill_overlap: ["skills candidate HAS that JD requires"],
    skill_gaps: ["required skills candidate is MISSING"],
    experience_fit: "brief assessment",
    domain_fit: "brief assessment",
    location_fit: "brief assessment",
    salary_fit: "brief assessment or unknown",
    education_fit: "brief assessment",
    standout_positives: ["2-3 things that make this candidate stand out"],
    potential_concerns: ["1-3 genuine concerns"],
    match_narrative: "2-3 sentence plain-English summary of fit",
  };

  const prompt = `Evaluate this candidate against the job description.

JOB DESCRIPTION:
- Role: ${jd.job_title} at ${jd.company}
- Required Skills: ${(jd.required_skills || []).join(", ")}
- Preferred Skills: ${(jd.preferred_skills || []).join(", ")}
- Experience: ${jd.years_min}-${jd.years_max} years (${jd.experience_level} level)
- Domain: ${jd.domain}
- Location: ${jd.location} (${jd.remote_policy})
- Salary: ${jd.salary_min ? `₹${(jd.salary_min / 100000).toFixed(0)}L-₹${(jd.salary_max / 100000).toFixed(0)}L` : "not specified"}

CANDIDATE:
- Name: ${candidate.name}
- Role: ${candidate.current_title} at ${candidate.current_company}
- Experience: ${candidate.years_of_experience} years
- Skills: ${candidate.skills.join(", ")}
- Domains: ${candidate.domain_experience.join(", ")}
- Education: ${candidate.education.join(", ")}
- Location: ${candidate.location} (remote ok: ${candidate.open_to_remote})
- Salary Expectation: ₹${(candidate.salary_expectation_min / 100000).toFixed(0)}L-₹${(candidate.salary_expectation_max / 100000).toFixed(0)}L
- Bio: ${candidate.bio}

Return JSON matching this schema:
${JSON.stringify(schema, null, 2)}`;

  const raw = await callClaude(client, system, prompt, 1500);
  const parsed = safeParseJSON(raw);
  return {
    match_score: parseFloat(parsed.match_score) || 0.5,
    explanation: parsed,
  };
}

async function runOutreach(jd, candidate, explanation, client, numTurns = 4) {
  const conversation = [];
  const now = new Date();
  const ts = (offsetH) =>
    new Date(now.getTime() + offsetH * 3600000).toISOString().slice(0, 16);

  const recruiterSystem = `You are Alex, a warm, consultative technical recruiter. 
You write short, personalized messages — never generic or pushy.
You reference specific things about the candidate's background.`;

  const openingPrompt = `Write a personalized LinkedIn DM to ${candidate.name} for this role.

Role: ${jd.job_title} at ${jd.company} (${jd.domain} domain)
Why they fit: ${explanation.match_narrative}
Their background: ${candidate.current_title} at ${candidate.current_company}, ${candidate.years_of_experience} yrs
Key hook: ${(explanation.standout_positives || [])[0] || "strong technical background"}

Write 3-4 natural sentences. Be specific to their background.`;

  const opening = await callClaude(client, recruiterSystem, openingPrompt, 400);
  conversation.push({
    role: "recruiter",
    message: opening,
    timestamp: ts(0),
    intent: "initial_outreach",
  });

  const candidateContext = `YOUR PROFILE:
Name: ${candidate.name} | Role: ${candidate.current_title} at ${candidate.current_company}
Experience: ${candidate.years_of_experience} years | Location: ${candidate.location}
Skills: ${candidate.skills.slice(0, 8).join(", ")}
Salary expectation: ₹${(candidate.salary_expectation_min / 100000).toFixed(0)}L-₹${(candidate.salary_expectation_max / 100000).toFixed(0)}L
Availability: ${candidate.availability} | Remote OK: ${candidate.open_to_remote}
Bio: ${candidate.bio}
Career trajectory: ${candidate.career_trajectory}

THIS OPPORTUNITY:
Role: ${jd.job_title} at ${jd.company} | Domain: ${jd.domain}
Location: ${jd.location} (${jd.remote_policy})
Salary: ${jd.salary_min ? `₹${(jd.salary_min / 100000).toFixed(0)}L-₹${(jd.salary_max / 100000).toFixed(0)}L` : "not disclosed"}
Your strengths for this role: ${(explanation.standout_positives || []).join(", ")}
Potential gaps: ${(explanation.skill_gaps || []).join(", ") || "none"}
Natural concerns you might have: ${(explanation.potential_concerns || []).join(", ") || "none"}

React authentically. If good fit → show genuine interest. If gaps/red flags → voice real hesitation.
Keep replies concise (2-4 sentences max).`;

  const candidateSystem = `You are a realistic job candidate responding to recruiter outreach.
You have real motivations, real concerns, and real constraints based on your profile.
Be authentic — not uniformly positive.`;

  const candHistory = [
    {
      role: "user",
      content: `${candidateContext}\n\nRecruiter messaged:\n\n${opening}\n\nHow do you respond? Write only your reply.`,
    },
  ];
  const recruiterHistory = [{ role: "user", content: opening }];

  const intents = ["gauge_interest", "explore_motivations", "address_concerns_and_close"];

  for (let i = 0; i < numTurns - 1; i++) {
    
    const candReply = await callClaude(client, candidateSystem, candHistory[candHistory.length - 1].content, 400);
    conversation.push({
      role: "candidate",
      message: candReply,
      timestamp: ts(i + 1),
      intent: "candidate_response",
    });
    candHistory.push({ role: "assistant", content: candReply });
    recruiterHistory.push({ role: "assistant", content: candReply });

    if (i >= numTurns - 2) break;

    const intent = intents[Math.min(i, intents.length - 1)];
    const followUpPrompt = `Continue the conversation with ${candidate.name}.
Goal: ${intent.replace(/_/g, " ")}
Role details: ${jd.job_title} | ${jd.company} | ${jd.remote_policy} | ${jd.salary_min ? `₹${(jd.salary_min/100000).toFixed(0)}L-₹${(jd.salary_max/100000).toFixed(0)}L` : "competitive salary"}
Key differentiators: ${(jd.key_differentiators || []).slice(0, 3).join(", ")}
Write 2-3 sentences max. Be conversational.`;

    recruiterHistory.push({ role: "user", content: followUpPrompt });
    const recruiterFollowUp = await callClaude(client, recruiterSystem, followUpPrompt, 300);
    conversation.push({
      role: "recruiter",
      message: recruiterFollowUp,
      timestamp: ts(i + 2),
      intent,
    });

    candHistory.push({ role: "user", content: `Recruiter says:\n${recruiterFollowUp}\n\nHow do you respond?` });
    recruiterHistory.push({ role: "assistant", content: recruiterFollowUp });
  }

  const transcript = conversation
    .map((t) => `[${t.role.toUpperCase()}]: ${t.message}`)
    .join("\n\n");

  const analyzerSystem = `You are an expert recruiter analyzing conversation transcripts.
Assess candidate interest level calibrated and honestly.
Return ONLY valid JSON.`;

  const analyzerPrompt = `Analyze this recruiter-candidate conversation and assess the candidate's genuine interest.

Context:
- Role: ${jd.job_title} at ${jd.company}
- Candidate: ${candidate.name} (${candidate.current_title})
- Salary alignment: JD ${jd.salary_min ? `₹${(jd.salary_min/100000).toFixed(0)}L-₹${(jd.salary_max/100000).toFixed(0)}L` : "TBD"} vs candidate ₹${(candidate.salary_expectation_min/100000).toFixed(0)}L-₹${(candidate.salary_expectation_max/100000).toFixed(0)}L

TRANSCRIPT:
${transcript}

Return JSON:
{
  "interest_signal": "highly_enthusiastic|interested|open|lukewarm|declined|unresponsive",
  "interest_score": "float 0.0-1.0",
  "interest_reasoning": "2-3 sentence explanation",
  "key_motivators": ["things that excited them"],
  "key_concerns": ["things that worried them"],
  "availability_confirmed": "what they said about timing",
  "salary_aligned": true or false,
  "next_step_agreed": "agreed next step or null"
}`;

  const analysisRaw = await callClaude(client, analyzerSystem, analyzerPrompt, 800);
  const analysis = safeParseJSON(analysisRaw);

  return {
    candidate_id: candidate.id,
    conversation,
    interest_signal: analysis.interest_signal || "open",
    interest_score: parseFloat(analysis.interest_score) || 0.5,
    interest_reasoning: analysis.interest_reasoning || "",
    key_motivators: analysis.key_motivators || [],
    key_concerns: analysis.key_concerns || [],
    availability_confirmed: analysis.availability_confirmed || "not confirmed",
    salary_aligned: !!analysis.salary_aligned,
    next_step_agreed: analysis.next_step_agreed || null,
  };
}

const INTEREST_SIGNAL_SCORES = {
  highly_enthusiastic: 1.0,
  interested: 0.75,
  open: 0.5,
  lukewarm: 0.25,
  declined: 0.05,
  unresponsive: 0.1,
};

function getPriorityLabel(combined, signal) {
  if (signal === "declined") return "Declined ✗";
  if (signal === "unresponsive") return "Unresponsive ?";
  if (combined >= 0.8) return "Hot 🔥";
  if (combined >= 0.65) return "Strong ⭐";
  if (combined >= 0.45) return "Potential 🔹";
  return "Low ❄️";
}

function getRecruiterAction(matchScore, signal, engagement) {
  if (signal === "declined") return "Candidate declined — archive and revisit in 6 months if role changes.";
  if (signal === "unresponsive") return "Send one follow-up in 5 days; if no response, move on.";
  if (signal === "highly_enthusiastic" || signal === "interested") {
    if (matchScore >= 0.75) return "Schedule technical screen immediately — high match + high interest.";
    if (matchScore >= 0.55) return "Schedule intro call to clarify skill gaps before technical round.";
    return "Intro call to explore interest despite moderate match — verify skills live.";
  }
  if (signal === "open") {
    if (matchScore >= 0.75) return "Strong match — send detailed JD and follow up to convert interest.";
    return "Share role details; low urgency. Revisit if stronger candidates drop.";
  }
  if (signal === "lukewarm") {
    if (matchScore >= 0.8) return "Excellent match despite lukewarm interest — share comp details to re-engage.";
    return "Borderline match + lukewarm interest — deprioritize for now.";
  }
  return "Review conversation manually before deciding next steps.";
}

function buildShortlist(scoredCandidates, engagements, matchWeight = 0.55, interestWeight = 0.45) {
  const ranked = scoredCandidates
    .map(({ candidate, match_score, explanation }) => {
      const engagement = engagements[candidate.id];
      if (!engagement) return null;

      const interestScore = engagement.interest_score;
      let combined = match_score * matchWeight + interestScore * interestWeight;
      if (engagement.interest_signal === "declined") combined = Math.min(combined, 0.15);
      combined = Math.round(Math.min(1, Math.max(0, combined)) * 1000) / 1000;

      return {
        candidate,
        match_score: Math.round(match_score * 1000) / 1000,
        interest_score: Math.round(interestScore * 1000) / 1000,
        combined_score: combined,
        priority_label: getPriorityLabel(combined, engagement.interest_signal),
        recruiter_action: getRecruiterAction(match_score, engagement.interest_signal, engagement),
        match_explanation: explanation,
        engagement,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.combined_score - a.combined_score)
    .map((item, i) => ({ rank: i + 1, ...item }));

  return ranked;
}

async function runScoutingPipeline(jobId, rawJD, apiKey, config = {}) {
  const {
    topKMatch = 8,
    shortlistSize = 5,
    conversationTurns = 4,
    matchWeight = 0.55,
    interestWeight = 0.45,
  } = config;

  const client = getClient(apiKey);

  function setProgress(stage, message, pct) {
    jobs[jobId] = { ...jobs[jobId], stage, message, progress: pct };
  }

  try {
    jobs[jobId].status = "running";

    setProgress("parsing", "Parsing job description with AI...", 5);
    const parsedJD = await parseJD(rawJD, client);
    setProgress("parsing", `Parsed: ${parsedJD.job_title} @ ${parsedJD.company}`, 15);

    setProgress("discovery", `Scanning ${CANDIDATES.length} candidates...`, 20);
    const withHeuristic = CANDIDATES.map((c) => ({
      candidate: c,
      hScore: heuristicScore(parsedJD, c),
    })).sort((a, b) => b.hScore - a.hScore);

    const preFiltered = withHeuristic.slice(0, topKMatch * 2).map((x) => x.candidate);
    setProgress("discovery", `Pre-filtered to top ${preFiltered.length} candidates`, 28);

    setProgress("matching", "AI scoring candidates against JD...", 30);
    const scored = [];
    for (let i = 0; i < Math.min(preFiltered.length, topKMatch); i++) {
      const candidate = preFiltered[i];
      setProgress("matching", `Scoring ${candidate.name}...`, 30 + Math.round((i / topKMatch) * 25));
      const { match_score, explanation } = await scoreCandidate(parsedJD, candidate, client);
      scored.push({ candidate, match_score, explanation });
    }
    scored.sort((a, b) => b.match_score - a.match_score);
    setProgress("matching", `Top ${scored.length} candidates scored`, 55);

    // Stage 4: Conversational Outreach
    const topForOutreach = scored.slice(0, shortlistSize + 2);
    const engagements = {};
    setProgress("outreach", "Starting conversational outreach simulations...", 58);

    for (let i = 0; i < topForOutreach.length; i++) {
      const { candidate, explanation } = topForOutreach[i];
      setProgress(
        "outreach",
        `Engaging ${candidate.name} (${i + 1}/${topForOutreach.length})...`,
        58 + Math.round((i / topForOutreach.length) * 25)
      );
      const engagement = await runOutreach(parsedJD, candidate, explanation, client, conversationTurns);
      engagements[candidate.id] = engagement;
    }
    setProgress("outreach", "All outreach conversations complete", 83);

    // Stage 5: Rank & Build Shortlist
    setProgress("ranking", "Computing final rankings...", 88);
    const shortlist = buildShortlist(topForOutreach, engagements, matchWeight, interestWeight).slice(
      0,
      shortlistSize
    );

    const result = {
      job_description: parsedJD,
      shortlist,
      pipeline_stats: {
        total_candidates_in_pool: CANDIDATES.length,
        candidates_ai_scored: scored.length,
        final_shortlist_size: shortlist.length,
      },
      config: { matchWeight, interestWeight, conversationTurns },
    };

    jobs[jobId].status = "complete";
    jobs[jobId].result = result;
    setProgress("complete", "Pipeline complete!", 100);
  } catch (err) {
    console.error(`[Job ${jobId}] Error:`, err);
    jobs[jobId].status = "error";
    jobs[jobId].error = err.message;
  }
}


app.get("/api/health", (req, res) => {
  res.json({ status: "ok", candidates_loaded: CANDIDATES.length });
});

app.get("/api/candidates", (req, res) => {
  res.json({
    count: CANDIDATES.length,
    candidates: CANDIDATES.map((c) => ({
      id: c.id,
      name: c.name,
      current_title: c.current_title,
      current_company: c.current_company,
      years_of_experience: c.years_of_experience,
      skills: c.skills.slice(0, 6),
      location: c.location,
      availability: c.availability,
      domain_experience: c.domain_experience,
    })),
  });
});

app.get("/api/candidates/:id", (req, res) => {
  const candidate = CANDIDATES.find((c) => c.id === req.params.id);
  if (!candidate) return res.status(404).json({ error: "Candidate not found" });
  res.json(candidate);
});

app.post("/api/parse-jd", async (req, res) => {
  const { job_description, api_key } = req.body;
  if (!job_description || !api_key)
    return res.status(400).json({ error: "job_description and api_key required" });
  try {
    const client = getClient(api_key);
    const parsed = await parseJD(job_description, client);
    res.json(parsed);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/scout/start", (req, res) => {
  const { job_description, api_key, config } = req.body;
  if (!job_description || !api_key)
    return res.status(400).json({ error: "job_description and api_key required" });

  const jobId = uuidv4();
  jobs[jobId] = { status: "queued", progress: 0, stage: "initializing", message: "Job queued" };

  runScoutingPipeline(jobId, job_description, api_key, config || {}).catch((err) => {
    console.error("Pipeline error:", err);
  });

  res.json({ job_id: jobId, status: "queued" });
});

app.get("/api/scout/status/:jobId", (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: "Job not found" });
  res.json({
    job_id: req.params.jobId,
    status: job.status,
    progress: job.progress,
    stage: job.stage,
    message: job.message,
    error: job.error || null,
  });
});

app.get("/api/scout/result/:jobId", (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: "Job not found" });
  if (job.status !== "complete")
    return res.status(202).json({ error: `Job is ${job.status}`, progress: job.progress });
  res.json(job.result);
});
app.get("/api/demo", (req, res) => {
  console.log("DEMO ROUTE HIT"); // debug line

  res.send("DEMO WORKING");
});
console.log("DEMO ROUTE REGISTERED");

app.get("/api/demo", (req, res) => {
  console.log("API HIT");

  res.json([
    {
      rank: 1,
      name: "Test Candidate",
      match_score: 0.9,
      interest_score: 0.8,
      engagement: {
        conversation: [
          { role: "recruiter", message: "Hi!", intent: "outreach" },
          { role: "candidate", message: "Interested!", intent: "positive" }
        ],
        interest_signal: "interested"
      }
    }
  ]);
});

app.listen(PORT, () => {
  console.log(`\n Talent Scout API running on http://localhost:${PORT}`);
  console.log(`   Candidates loaded: ${CANDIDATES.length}`);
  console.log(`   Endpoints:`);
  console.log(`     GET  /api/health`);
  console.log(`     GET  /api/candidates`);
  console.log(`     POST /api/parse-jd`);
  console.log(`     POST /api/scout/start`);
  console.log(`     GET  /api/scout/status/:jobId`);
  console.log(`     GET  /api/scout/result/:jobId\n`);
});