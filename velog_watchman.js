import fs from "fs";
import path from "path";
import chokidar from "chokidar";
import { GoogleGenAI } from "@google/genai";
import fetch from "node-fetch";

// ==================== [ 필수 설정 정보 ] ====================
const GEMINI_API_KEY = "Your AI API Key"; // 발급받은 Gemini API Key
const VELOG_TOKEN =
  "Your Velog access_token"; // 브라우저 쿠키에서 복사한 Velog access_token

// 사용자의 다운로드 폴더 경로 자동 지정
const DOWNLOADS_DIR = path.join(
  process.env.USERPROFILE || process.env.HOME,
  "Downloads",
);

// 확장 프로그램이 내보내는 파일 패턴 감시 (chokidar용)
// 윈도우 환경의 역슬래시(\) 경로 호환성을 위해 슬래시(/)로 변경
const WATCH_TARGET = DOWNLOADS_DIR;
// ============================================================

const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

console.log(
  `👀 [감시 시작] 다운로드 폴더에 생성되는 JSON 파일을 감시합니다...`,
);
console.log(`📂 감시 경로: ${WATCH_TARGET}`);

try {
  const files = fs.readdirSync(DOWNLOADS_DIR);
  console.log(`📂 현재 다운로드 폴더에 있는 파일 수: ${files.length}개`);
} catch (err) {
  console.error("❌ 다운로드 폴더에 접근할 수 없습니다:", err);
}

// 파일 감시자(Watcher) 기동
const watcher = chokidar.watch(WATCH_TARGET, {
  persistent: true,
  ignoreInitial: true, // 스크립트 실행 이전에 있던 기존 파일들은 처리하지 않음
  depth: 0, // 최상위 폴더만 감시 (하위 폴더는 감시하지 않음)
  awaitWriteFinish: {
    stabilityThreshold: 2000, // 파일 다운로드가 완전히 끝날 때까지 2초간 대기
    pollInterval: 10000, // 파일 상태를 10초마다 체크하여 서버 과부하 방지
  },
});

// 다운로드 폴더에 새 파일이 들어왔을 때의 메인 이벤트 로직
watcher.on("add", async (filePath) => {
  const fileName = path.basename(filePath);

  // 디버깅용: 폴더에 파일이 생기면 무조건 어떤 파일인지 로그를 찍도록 최상단에 배치
  console.log(` Detected file: ${fileName}`);

  // 확장 프로그램이 뽑아주는 파일 구조인지 식별하기 위해 제목 체크 혹은 예외 처리
  if (!fileName.endsWith(".json") || !fileName.includes("Gemini-chat")) {
    // 만약 파일 이름에 'Gemini-chat'가 포함되지 않는 일반 json이라면 오작동 방지를 위해 패스할 수 있습니다.
    // 필요에 따라 이 조건문은 수정하거나 제거하셔도 됩니다.
  }

  console.log(`\n--------------------------------------------------`);
  console.log(`✨ 새 백업 파일 감지됨: ${fileName}`);

  try {
    // 1. 파일 읽기 및 JSON 파싱
    const rawData = fs.readFileSync(filePath, "utf-8");
    const chatData = JSON.parse(rawData);

    // 안전장치: 확장 프로그램 포맷이 맞는지 구조 확인 (metadata와 messages가 있는지)
    if (!chatData.metadata || !chatData.messages) {
      console.log(
        "⏭️ 제공된 파일이 'AI 채팅 익스포터'의 형식이 아니므로 건너뜁니다.",
      );
      return;
    }

    // 실제 메타데이터에서 제목 추출
    const blogTitle = chatData.metadata.title || "Gemini 대화 기반 기술 포스팅";
    console.log(`📝 포스팅 제목(유추됨): [ ${blogTitle} ]`);

    // 2. 대화 기록 데이터를 AI가 가공하기 좋은 문자열 텍스트로 정제
    console.log("🔄 대화 텍스트 정제 중...");
    let conversationText = "";
    chatData.messages.forEach((msg) => {
      const speaker =
        msg.role === "Prompt" ? "사용자(User)" : "제미나이(Gemini)";
      conversationText += `\n[${speaker}]\n${msg.say}\n`;
    });

    // 3. Gemini API를 사용하여 블로그 글로 가공 및 태그 추출 요청
    console.log("🚀 1단계: Gemini가 내용을 분석하여 기술 블로그로 가공 중...");

    const prompt = `
당신은 대한민국 최고의 기술 블로그 전문 에디터이자 테크 라이터입니다. 
다음은 개발자와 AI가 나눈 대화 기록입니다. 이 내용을 기반으로 Velog에 올릴 만한 완성도 높은 기술 블로그 포스팅을 작성해주세요.

[작성 가이드라인]
1. 단순 대화 받아쓰기가 아닌, 완성된 하나의 '기술 가이드/회고 글' 형태로 서론-본론-결론 구조를 갖추어 변환하세요.
2. 독자가 이해하기 쉽게 명확하고 정중한 개발자 톤앤매너(~습니다 체)를 유지하세요.
3. 대화 중에 포함된 개발 코드 블록은 마크다운 문법(\`\`\`javascript 등)을 정확히 지켜 가독성을 극대화하고, 코드 아래에 핵심 로직 설명을 첨부하세요.


[대화 기록]
${conversationText}
`;

    // 💡 [핵심 변경사항] AI가 반환할 JSON의 구조(Schema)를 엄격하게 정의합니다.
    const responseSchema = {
      type: "OBJECT",
      properties: {
        content: {
          type: "STRING",
          description: "가공된 완성형 마크다운 기술 블로그 본문 전체",
        },
        tags: {
          type: "ARRAY",
          items: { type: "STRING" },
          description:
            "글에 어울리는 기술 블로그 태그 키워드 리스트 (최대 5개)",
        },
      },
      required: ["content", "tags"],
    };

    const aiResponse = await ai.models.generateContent({
      model: "gemini-2.5-flash", // 속도와 비용 효율이 좋은 최신 모델
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        responseSchema: responseSchema,
      },
    });

    // AI의 응답에서 JSON 파싱
    const refinedBlog = JSON.parse(aiResponse.text.trim());

    console.log(
      `✅ AI 가공 완료! (추출된 태그: ${refinedBlog.tags.join(", ")})`,
    );
    console.log("🚀 2단계: Velog GraphQL API를 사용하여 임시저장 전송 중...");

    // 4. Velog GraphQL API 호출 (임시저장)
    const url = "https://api.velog.io/graphql";
    const query = `
            mutation WritePost(
                $title: String, 
                $body: String, 
                $tags: [String], 
                $is_markdown: Boolean, 
                $is_temp: Boolean, 
                $is_private: Boolean, 
                $url_slug: String, 
                $thumbnail: String, 
                $meta: JSON, 
                $series_id: ID, 
                $token: String
            ) {
                writePost(
                    title: $title, 
                    body: $body, 
                    tags: $tags, 
                    is_markdown: $is_markdown, 
                    is_temp: $is_temp, 
                    is_private: $is_private, 
                    url_slug: $url_slug, 
                    thumbnail: $thumbnail, 
                    meta: $meta, 
                    series_id: $series_id, 
                    token: $token
                ) {
                    id
                    user {
                        id
                        username
                    }
                    url_slug
                }
            }
        `;

    const variables = {
      title: blogTitle.trim() || "Gemini AI 자동 생성 포스팅",
      body: refinedBlog.content,
      tags: refinedBlog.tags || ["Gemini"],
      is_markdown: true,
      is_temp: true, // 임시저장 활성화
      is_private: false,
      url_slug: "", // 임시저장 시에는 빈 값으로 보내도 Velog가 알아서 생성하거나 비워둡니다.
      thumbnail: null,
      meta: {}, // 비어있는 JSON 객체 전달
      series_id: null,
      token: null, // 일반 로그인 유저는 보통 쿠키 토큰을 쓰므로 null 처리해도 무방합니다.
    };

    console.log("📤 [Velog 전송 데이터 확인]");
    console.log(`- 제목: ${variables.title}`);
    console.log(`- 본문 길이: ${variables.body.length}자`);
    console.log("---------------------------------");

    const velogResponse = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `access_token=${VELOG_TOKEN}`,
      },
      body: JSON.stringify({ query, variables }),
    });

    const velogResult = await velogResponse.json();

    console.log("=== [Velog API Raw Response] ===");
    console.log(JSON.stringify(velogResult, null, 2));
    console.log("=================================");

    if (
      velogResult.errors ||
      !velogResult.data ||
      !velogResult.data.writePost
    ) {
      console.error(
        "❌ Velog API 처리 중 에러가 발생했거나 응답이 올바르지 않습니다.",
      );
      if (velogResult.errors) {
        console.error(
          "상세 에러 내용:",
          JSON.stringify(velogResult.errors, null, 2),
        );
      }
      return;
    }

    // 성공한 경우에만 안전하게 데이터에 접근
    const savedPost = velogResult.data.writePost;
    console.log(
      `🎉 [완료] Velog 임시저장함에 안전하게 저장되었습니다! (Slug: ${savedPost.url_slug})`,
    );

    // 5. 후처리: 처리 완료된 파일 삭제
    fs.unlinkSync(filePath);
    console.log(`🗑️ 다운로드 폴더에서 임시 파일(${fileName})을 삭제했습니다.`);
  } catch (error) {
    console.error("❌ 시스템 처리 중 에러가 발생했습니다:", error);
  }
  console.log(`--------------------------------------------------`);
});
