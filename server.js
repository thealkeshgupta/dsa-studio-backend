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

  // Crucial for preventing the 500 HTML error on mutations (like saving notes)
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

  const filters = {};
  if (searchKeyword) filters.searchKeywords = searchKeyword;
  if (tags.length > 0) filters.tags = tags;

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

// 1. Fetch Past Submissions List
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

// 2. Fetch Specific Submission Detail (with submitted code)
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

// 3. Fetch User Notes
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

// 4. Save User Notes to LeetCode (Fixed GraphQL Mutation)
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
