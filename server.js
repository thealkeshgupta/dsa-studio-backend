const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// --- GRAPHQL HELPER ---
async function fetchLeetCodeGraphQL(query, variables = {}) {
  const headers = {
    "Content-Type": "application/json",
    Cookie: `LEETCODE_SESSION=${process.env.LEETCODE_SESSION || ""}; csrftoken=${process.env.CSRF_TOKEN || ""}`,
    Referer: "https://leetcode.com/",
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  };

  if (process.env.CSRF_TOKEN) {
    headers["X-CSRFToken"] = process.env.CSRF_TOKEN;
  }

  const response = await fetch("https://leetcode.com/graphql", {
    method: "POST",
    headers,
    body: JSON.stringify({ query, variables }),
  });

  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch (err) {
    console.error("LeetCode response parse failed:", text.substring(0, 100));
    throw new Error(`LeetCode API Error: ${text.substring(0, 100)}...`);
  }
}

// --- ENDPOINTS: PIN VERIFICATION ---
app.post("/api/verify-pin", (req, res) => {
  const { pin } = req.body;
  const expectedPin = process.env.APP_PIN || "1234";
  if (pin === expectedPin) {
    res.json({ success: true });
  } else {
    res.status(401).json({ success: false, error: "Incorrect PIN" });
  }
});

// --- ENDPOINTS: SESSION MANAGEMENT ---
app.get("/api/status", async (req, res) => {
  try {
    const data = await fetchLeetCodeGraphQL(
      `query globalData { userStatus { isSignedIn username } }`,
    );
    const userStatus = data.data?.userStatus;
    if (userStatus && userStatus.isSignedIn) {
      res.json({ loggedIn: true, username: userStatus.username });
    } else {
      res.json({ loggedIn: false });
    }
  } catch (error) {
    res.json({ loggedIn: false, error: "Failed to verify session" });
  }
});

app.post("/api/update-session", (req, res) => {
  const { session, csrf } = req.body;
  if (!session)
    return res
      .status(400)
      .json({ success: false, error: "LEETCODE_SESSION is required." });

  process.env.LEETCODE_SESSION = session;
  if (csrf) process.env.CSRF_TOKEN = csrf;

  try {
    const envPath = path.join(__dirname, ".env");
    let envContent = fs.existsSync(envPath)
      ? fs.readFileSync(envPath, "utf8")
      : "";
    if (envContent.includes("LEETCODE_SESSION=")) {
      envContent = envContent.replace(
        /LEETCODE_SESSION=.*/g,
        `LEETCODE_SESSION=${session}`,
      );
      if (csrf)
        envContent = envContent.replace(/CSRF_TOKEN=.*/g, `CSRF_TOKEN=${csrf}`);
    } else {
      envContent += `\nLEETCODE_SESSION=${session}\nCSRF_TOKEN=${csrf || ""}\n`;
    }
    fs.writeFileSync(envPath, envContent);
  } catch (err) {
    console.log(
      "Could not write to .env file, continuing with in-memory update.",
    );
  }
  res.json({ success: true, message: "Session updated successfully." });
});

// --- ENDPOINTS: PROBLEM BROWSING ---
app.get("/api/tags", async (req, res) => {
  try {
    const data = await fetchLeetCodeGraphQL(
      `query questionTags { questionTags { name slug } }`,
    );
    res.json(data.data?.questionTags || []);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/problems", async (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const skip = parseInt(req.query.skip) || 0;
  const searchKeyword = req.query.search || "";
  const tags = req.query.tags ? req.query.tags.split(",") : [];
  const difficulty = req.query.difficulty || "";

  const filters = {};
  if (searchKeyword) filters.searchKeywords = searchKeyword;
  if (tags.length > 0) filters.tags = tags;
  if (difficulty) filters.difficulty = difficulty.toUpperCase();

  try {
    const data = await fetchLeetCodeGraphQL(
      `query problemsetQuestionList($categorySlug: String, $limit: Int, $skip: Int, $filters: QuestionListFilterInput) {
        problemsetQuestionList: questionList(categorySlug: $categorySlug, limit: $limit, skip: $skip, filters: $filters) {
          total: totalNum
          questions: data { questionFrontendId difficulty title titleSlug status topicTags { name slug } }
        }
      }`,
      { categorySlug: "", limit, skip, filters },
    );
    res.json(data.data?.problemsetQuestionList || { total: 0, questions: [] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/problems/:slug", async (req, res) => {
  try {
    const data = await fetchLeetCodeGraphQL(
      `query questionData($titleSlug: String!) {
        question(titleSlug: $titleSlug) {
          questionId questionFrontendId title titleSlug content difficulty status exampleTestcases
          codeSnippets { lang langSlug code }
        }
      }`,
      { titleSlug: req.params.slug },
    );

    const question = data.data?.question;
    if (!question) return res.status(404).json({ error: "Problem not found" });

    const javaSnippet = question.codeSnippets?.find((s) => s.lang === "Java");
    res.json({
      id: question.questionId,
      frontendId: question.questionFrontendId,
      name: question.title,
      slug: question.titleSlug,
      difficulty: question.difficulty,
      status: question.status,
      content: question.content,
      defaultCode: javaSnippet ? javaSnippet.code : "",
      exampleTestcases: question.exampleTestcases,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// --- ENDPOINTS: CURATED LISTS & PROGRESS ---
app.get("/api/solved", async (req, res) => {
  try {
    const response = await fetch(
      "https://leetcode.com/api/problems/algorithms/",
      {
        headers: {
          "Content-Type": "application/json",
          Cookie: `LEETCODE_SESSION=${process.env.LEETCODE_SESSION || ""}; csrftoken=${process.env.CSRF_TOKEN || ""}`,
        },
      },
    );
    const data = await response.json();
    if (!data.stat_status_pairs) {
      return res.json({ solved: [] });
    }
    const solvedSlugs = data.stat_status_pairs
      .filter((p) => p.status === "ac")
      .map((p) => p.stat.question__title_slug);
    res.json({ solved: solvedSlugs });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/lists", (req, res) => {
  try {
    const listsDir = path.join(__dirname, "data", "lists");
    if (!fs.existsSync(listsDir)) {
      fs.mkdirSync(listsDir, { recursive: true });
      return res.json([]);
    }
    const files = fs.readdirSync(listsDir).filter((f) => f.endsWith(".json"));
    const lists = files.map((file) => {
      const rawData = fs.readFileSync(path.join(listsDir, file), "utf8");
      const data = JSON.parse(rawData);
      return {
        id: data.id,
        title: data.title,
        description: data.description || "",
        totalProblems: data.totalProblems,
      };
    });
    res.json(lists);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/lists/:id", (req, res) => {
  try {
    const filePath = path.join(
      __dirname,
      "data",
      "lists",
      `${req.params.id}.json`,
    );
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: "List not found" });
    }
    const rawData = fs.readFileSync(filePath, "utf8");
    res.json(JSON.parse(rawData));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// --- ENDPOINTS: WORKSPACE PRO FEATURES (NOTES & SUBMISSIONS) ---
app.get("/api/submissions/:slug", async (req, res) => {
  try {
    const data = await fetchLeetCodeGraphQL(
      `query submissionList($offset: Int!, $limit: Int!, $questionSlug: String!) {
        questionSubmissionList(offset: $offset, limit: $limit, questionSlug: $questionSlug) {
          submissions { id statusDisplay lang runtime memory timestamp }
        }
      }`,
      { offset: 0, limit: 20, questionSlug: req.params.slug },
    );
    res.json(data.data?.questionSubmissionList?.submissions || []);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/submission/:id", async (req, res) => {
  try {
    const subData = await fetchLeetCodeGraphQL(
      `query submissionDetails($submissionId: Int!) { 
        submissionDetails(submissionId: $submissionId) { 
          runtimeDisplay runtimePercentile memoryDisplay memoryPercentile code timestamp 
        } 
      }`,
      { submissionId: parseInt(req.params.id) },
    );
    res.json(subData?.data?.submissionDetails || {});
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/notes/:slug", async (req, res) => {
  try {
    const data = await fetchLeetCodeGraphQL(
      `query QuestionNote($titleSlug: String!) {
        question(titleSlug: $titleSlug) { note }
      }`,
      { titleSlug: req.params.slug },
    );
    res.json({ note: data.data?.question?.note || "" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/notes/:slug", async (req, res) => {
  try {
    const { note } = req.body;
    const titleSlug = req.params.slug;

    const data = await fetchLeetCodeGraphQL(
      `mutation updateNote($titleSlug: String!, $content: String!) {
        updateNote(titleSlug: $titleSlug, content: $content) { ok }
      }`,
      { titleSlug: titleSlug, content: note || "" },
    );

    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// --- OPTION 1: IMAGE PROXY ENDPOINT ---
app.get("/api/pro-image", async (req, res) => {
  try {
    const imageUrl = req.query.url;
    if (!imageUrl) return res.status(400).send("Missing url parameter");

    const response = await fetch(imageUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        Referer: "https://leetcode.com/",
      },
    });

    if (!response.ok) throw new Error("Failed to fetch image");

    const contentType = response.headers.get("content-type");
    res.setHeader("Content-Type", contentType);

    const buffer = await response.arrayBuffer();
    res.send(Buffer.from(buffer));
  } catch (error) {
    res.status(500).send("Error proxying image");
  }
});

// --- NEW ENDPOINTS: COMPANY WISE ARCHIVES (OFFLINE CACHED) ---
const companyDataCache = {};

// --- LOCAL LOGO MAPPING (No Hardcoded Counts) ---
const TOP_COMPANIES = {
  Amazon: { logo: "/logos/amazon.svg" },
  Google: { logo: "/logos/google.svg" },
  Meta: { logo: "/logos/meta.svg" },
  Facebook: { logo: "/logos/meta.svg" },
  Microsoft: { logo: "/logos/microsoft.svg" },
  Apple: { logo: "/logos/apple.svg" },
  "J.P. Morgan": { logo: "/logos/jpmc.png" }, // Exact match from GitHub!
  Uber: { logo: "/logos/uber.svg" },
  Adobe: { logo: "/logos/adobe.svg" },
  ByteDance: { logo: "/logos/bytedance.svg" },
  "Goldman Sachs": { logo: "/logos/gs.png" },
  "Goldman%20Sachs": { logo: "/logos/gs.png" }, // Fallback for encoded slug
};

app.get("/api/companies", (req, res) => {
  const filePath = path.join(__dirname, "data", "companies.json");

  if (fs.existsSync(filePath)) {
    const rawData = fs.readFileSync(filePath, "utf8");
    const allCompanies = JSON.parse(rawData);

    // Clean, direct lookup without forced overrides
    const enrichedCompanies = allCompanies.map((company) => {
      // Check both the raw name and the decoded slug
      const decodedSlug = decodeURIComponent(company.slug);
      const topData = TOP_COMPANIES[company.name] || TOP_COMPANIES[decodedSlug];

      if (topData) {
        return { ...company, logo: topData.logo };
      }
      return company;
    });

    // Sort top tier companies with logos to the very top, alphabetize the rest
    enrichedCompanies.sort((a, b) => {
      if (a.logo && !b.logo) return -1;
      if (!a.logo && b.logo) return 1;
      return a.name.localeCompare(b.name);
    });

    return res.json(enrichedCompanies);
  }

  res.json([]);
});

app.get("/api/companies/:company", async (req, res) => {
  const company = req.params.company;
  const timeframes = [
    { id: "30_days", file: "1.%20Thirty%20Days.csv" },
    { id: "3_months", file: "2.%20Three%20Months.csv" },
    { id: "6_months", file: "3.%20Six%20Months.csv" },
    { id: "more_than_6_months", file: "4.%20More%20Than%20Six%20Months.csv" },
    { id: "all_time", file: "5.%20All.csv" },
  ];

  if (companyDataCache[company]) {
    return res.json(companyDataCache[company]);
  }

  try {
    const results = {};
    for (const tf of timeframes) {
      // NOTE: Fetching from raw.githubusercontent is NEVER rate-limited!
      const url = `https://raw.githubusercontent.com/liquidslr/leetcode-company-wise-problems/main/${company}/${tf.file}`;
      const response = await fetch(url);

      if (!response.ok) {
        results[tf.id] = [];
        continue;
      }

      const csvText = await response.text();
      const lines = csvText
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l);
      const parsed = [];

      if (lines.length > 0) {
        const headers = lines[0]
          .split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/)
          .map((h) => h.replace(/^"|"$/g, "").trim().toLowerCase());
        const idIdx = headers.findIndex((h) => h === "id");
        const titleIdx = headers.findIndex((h) => h === "title");
        const diffIdx = headers.findIndex((h) => h === "difficulty");
        const freqIdx = headers.findIndex((h) => h === "frequency");
        const linkIdx = headers.findIndex(
          (h) => h.includes("link") || h.includes("url"),
        );

        for (let i = 1; i < lines.length; i++) {
          const cols = lines[i]
            .split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/)
            .map((c) => c.replace(/^"|"$/g, ""));
          if (cols.length > Math.max(idIdx, titleIdx, linkIdx)) {
            let link =
              linkIdx >= 0 && cols[linkIdx] ? cols[linkIdx].trim() : "";
            let slug = "";
            const match = link.match(/problems\/([^/]+)/);
            if (match) slug = match[1];

            parsed.push({
              id: idIdx >= 0 && cols[idIdx] ? cols[idIdx].trim() : "",
              title:
                titleIdx >= 0 && cols[titleIdx] ? cols[titleIdx].trim() : "",
              difficulty:
                diffIdx >= 0 && cols[diffIdx] ? cols[diffIdx].trim() : "Medium",
              frequency:
                freqIdx >= 0 && cols[freqIdx] ? cols[freqIdx].trim() : "",
              slug: slug,
            });
          }
        }
      }
      results[tf.id] = parsed;
    }

    companyDataCache[company] = results;
    res.json(results);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch company data" });
  }
});

// --- NATIVE API AUTOMATION ---
async function executeOnLeetCode(problemSlug, codeString, action = "submit") {
  if (!process.env.LEETCODE_SESSION || !process.env.CSRF_TOKEN) {
    return {
      success: false,
      error:
        "Missing LEETCODE_SESSION or CSRF_TOKEN. Please update your session cookies in the app.",
    };
  }

  try {
    const qData = await fetchLeetCodeGraphQL(
      `query questionData($titleSlug: String!) { question(titleSlug: $titleSlug) { questionId exampleTestcases } }`,
      { titleSlug: problemSlug },
    );
    const question = qData?.data?.question;
    if (!question)
      throw new Error("Could not fetch problem details from LeetCode.");

    const rawInput = (question.exampleTestcases || "").trim();

    const headers = {
      "Content-Type": "application/json",
      Referer: `https://leetcode.com/problems/${problemSlug}/`,
      Cookie: `LEETCODE_SESSION=${process.env.LEETCODE_SESSION}; csrftoken=${process.env.CSRF_TOKEN}`,
      "X-CSRFToken": process.env.CSRF_TOKEN,
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    };

    let submissionId;

    if (action === "submit") {
      const res = await fetch(
        `https://leetcode.com/problems/${problemSlug}/submit/`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            lang: "java",
            question_id: question.questionId,
            typed_code: codeString,
          }),
        },
      );
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      submissionId = data.submission_id;
    } else {
      const res = await fetch(
        `https://leetcode.com/problems/${problemSlug}/interpret_solution/`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            lang: "java",
            question_id: question.questionId,
            typed_code: codeString,
            data_input: rawInput,
          }),
        },
      );
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      submissionId = data.interpret_id;
    }

    let attempts = 0;
    let finalData = null;
    while (attempts < 20) {
      await new Promise((r) => setTimeout(r, 1000));
      const checkRes = await fetch(
        `https://leetcode.com/submissions/detail/${submissionId}/check/`,
        { headers },
      );
      const checkData = await checkRes.json();

      if (checkData.state === "SUCCESS") {
        finalData = checkData;
        break;
      }
      attempts++;
    }

    if (!finalData)
      throw new Error(
        "Execution timed out while waiting for LeetCode servers.",
      );

    if (action === "submit") {
      const status = finalData.status_msg;
      const result = { success: true, action, status };

      if (status === "Accepted") {
        result.passedTestcases = finalData.total_correct;
        result.totalTestcases = finalData.total_testcases;
        result.runtime = finalData.status_runtime || "N/A";
        result.runtimePercentile = "N/A";
        result.memoryPercentile = "N/A";

        let memVal = finalData.status_memory || finalData.memory;

        try {
          const subData = await fetchLeetCodeGraphQL(
            `query submissionDetails($submissionId: Int!) { submissionDetails(submissionId: $submissionId) { runtimeDisplay runtimePercentile memoryDisplay memoryPercentile } }`,
            { submissionId: parseInt(submissionId) },
          );
          const details = subData?.data?.submissionDetails;
          if (details) {
            result.runtime = details.runtimeDisplay || result.runtime;
            result.runtimePercentile = details.runtimePercentile
              ? details.runtimePercentile.toFixed(2) + "%"
              : "N/A";
            result.memoryPercentile = details.memoryPercentile
              ? details.memoryPercentile.toFixed(2) + "%"
              : "N/A";
            if (details.memoryDisplay) memVal = details.memoryDisplay;
          }
        } catch (e) {}

        if (typeof memVal === "string" && memVal.includes("MB")) {
          result.memory = memVal;
        } else if (memVal) {
          result.memory = (Number(memVal) / 1000000).toFixed(1) + " MB";
        } else {
          result.memory = "N/A";
        }
      } else {
        result.failedTestCase = {
          input:
            finalData.input_formatted ||
            finalData.last_testcase ||
            finalData.input ||
            "N/A",
          output:
            finalData.code_output ||
            finalData.compile_error ||
            finalData.runtime_error ||
            "N/A",
          expected: finalData.expected_output || "N/A",
        };
      }
      return result;
    } else {
      const outputs = finalData.code_answer || [];
      const expected = finalData.expected_code_answer || [];

      if (outputs.length === 0) {
        let crashOutput = finalData.compile_error || finalData.runtime_error;

        if (!crashOutput) {
          if (
            Array.isArray(finalData.code_output) &&
            finalData.code_output.length > 0
          ) {
            crashOutput = finalData.code_output.join("\n");
          } else if (
            typeof finalData.code_output === "string" &&
            finalData.code_output.trim() !== ""
          ) {
            crashOutput = finalData.code_output;
          } else {
            crashOutput = `Process Aborted: ${finalData.status_msg}`;
          }
        }

        return {
          success: true,
          action,
          status: finalData.status_msg,
          testCases: [
            {
              case: "Execution Result",
              input: rawInput || "N/A",
              output: crashOutput,
              expected: expected.length > 0 ? expected.join("\n---\n") : "N/A",
            },
          ],
        };
      }

      const inputLines = rawInput.split("\n");
      let numCases = expected.length > 0 ? expected.length : outputs.length;

      if (
        numCases > 0 &&
        inputLines.length > 0 &&
        inputLines.length % numCases !== 0
      ) {
        if (numCases > 1 && inputLines.length % (numCases - 1) === 0) {
          numCases -= 1;
        }
      }

      const linesPerCase =
        numCases > 0 ? Math.floor(inputLines.length / numCases) : 0;

      let runStatus = finalData.status_msg;
      if (runStatus === "Accepted") {
        for (let i = 0; i < numCases; i++) {
          if (outputs[i] !== expected[i]) {
            runStatus = "Wrong Answer";
            break;
          }
        }
      }

      const testCases = [];
      for (let i = 0; i < numCases; i++) {
        const caseInput = inputLines
          .slice(i * linesPerCase, (i + 1) * linesPerCase)
          .join("\n");
        testCases.push({
          case: `Case ${i + 1}`,
          input: caseInput || "N/A",
          output: outputs[i] !== undefined ? outputs[i] : "N/A",
          expected: expected[i] !== undefined ? expected[i] : "N/A",
        });
      }

      return { success: true, action, status: runStatus, testCases };
    }
  } catch (error) {
    return { success: false, error: error.message };
  }
}

app.post("/api/run", async (req, res) => {
  const result = await executeOnLeetCode(
    req.body.problemSlug,
    req.body.code,
    "run",
  );
  res.status(result.success ? 200 : 500).json(result);
});

app.post("/api/submit", async (req, res) => {
  const result = await executeOnLeetCode(
    req.body.problemSlug,
    req.body.code,
    "submit",
  );
  res.status(result.success ? 200 : 500).json(result);
});

app.listen(PORT, () =>
  console.log(`DSA Backend Engine running on http://localhost:${PORT}`),
);
