# ai-talent-agent
## Sample Inputs and Outputs

### Sample Input
Job Description:
Looking for a Python developer with Machine Learning experience and backend skills.


### Sample Output
Ranked Candidate Shortlist:

1. Kavya Sharma  
   Match Score: 0.92  
   Interest Score: 0.87  

   Conversation:
   Recruiter: Hi! We have a role matching your ML experience. Interested?  
   Candidate: That sounds interesting. Can you share more details?  
   Recruiter: You will work on real-world AI systems.  
   Candidate: That aligns with my goals. I'd love to explore further.  

---

### Explanation
- Match Score reflects skill alignment with the job description  
- Interest Score is derived from simulated conversation responses

## Architecture

The system follows a modular pipeline:

1. The user provides a Job Description through the frontend UI.
2. The frontend sends the request to the backend API.
3. The backend processes candidate data from a structured dataset.
4. A matching engine evaluates candidates based on skill alignment.
5. A conversation simulation module mimics recruiter-candidate interaction.
6. An interest scoring system evaluates candidate intent based on responses.
7. The system outputs a ranked shortlist of candidates.

---

## Scoring Logic

The system evaluates candidates on two dimensions:

### 1. Match Score
- Based on alignment between job requirements and candidate skills
- Considers experience, domain relevance, and skill overlap

### 2. Interest Score
- Derived from simulated recruiter-candidate conversation
- Positive responses increase score
- Neutral or negative responses reduce score

---

## Ranking Strategy

Candidates are ranked using a weighted combination:

Combined Score = 0.7 × Match Score + 0.3 × Interest Score

This ensures:
- High skill fit is prioritized
- Genuine candidate interest is also considered

---

## Trade-offs

- AI responses are simulated for reliability in demo mode
- Focus is on demonstrating pipeline rather than real-time LLM dependency
