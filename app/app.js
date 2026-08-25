(function () {
  const MISTAKE_STORAGE_KEY = "pte-core-wfd-mistake-book";
  const SESSION_STORAGE_KEY = "pte-core-wfd-session";
  const FEEDBACK_SETTINGS_KEY = "pte-core-wfd-feedback-settings";
  const ADVANCE_DELAY_MS = 1300;
  const AUDIO_PREROLL_SECONDS = 0.18;
  const FEEDBACK_AUDIO_URLS = {
    correct: "/assets/feedback-correct-v2.mp3",
    wrong: "/assets/feedback-wrong.mp3",
  };

  const elements = {
    dataSummary: document.getElementById("dataSummary"),
    practiceMode: document.getElementById("practiceMode"),
    answerSeconds: document.getElementById("answerSeconds"),
    autoAdvance: document.getElementById("autoAdvance"),
    soundEnabled: document.getElementById("soundEnabled"),
    soundVolume: document.getElementById("soundVolume"),
    soundVolumeLabel: document.getElementById("soundVolumeLabel"),
    jumpQuestionInput: document.getElementById("jumpQuestionInput"),
    jumpButton: document.getElementById("jumpButton"),
    startButton: document.getElementById("startButton"),
    startMistakesButton: document.getElementById("startMistakesButton"),
    resumeButton: document.getElementById("resumeButton"),
    playButton: document.getElementById("playButton"),
    submitButton: document.getElementById("submitButton"),
    retryButton: document.getElementById("retryButton"),
    nextButton: document.getElementById("nextButton"),
    resumeSummary: document.getElementById("resumeSummary"),
    questionLabel: document.getElementById("questionLabel"),
    phaseLabel: document.getElementById("phaseLabel"),
    timerLabel: document.getElementById("timerLabel"),
    mistakeCountLabel: document.getElementById("mistakeCountLabel"),
    answerInput: document.getElementById("answerInput"),
    resultSummary: document.getElementById("resultSummary"),
    expectedTokens: document.getElementById("expectedTokens"),
    actualTokens: document.getElementById("actualTokens"),
    issueList: document.getElementById("issueList"),
    formatList: document.getElementById("formatList"),
    mistakeList: document.getElementById("mistakeList"),
    copyMistakesButton: document.getElementById("copyMistakesButton"),
    clearMistakesButton: document.getElementById("clearMistakesButton"),
  };

  const state = {
    dataset: null,
    queue: [],
    queueIndex: -1,
    phase: "idle",
    countdownTimerId: null,
    countdownDeadline: null,
    advanceTimerId: null,
    audioContext: null,
    audioBuffers: new Map(),
    audioLoads: new Map(),
    currentSource: null,
    fallbackAudio: new Audio(),
    fallbackPrimedId: null,
    feedbackBuffers: new Map(),
    feedbackLoads: new Map(),
    currentFeedbackSource: null,
    feedbackFallbackAudio: {
      correct: new Audio(FEEDBACK_AUDIO_URLS.correct),
      wrong: new Audio(FEEDBACK_AUDIO_URLS.wrong),
    },
    playbackToken: 0,
    currentEvaluation: null,
    mistakeBook: loadMistakeBook(),
    sessionProgress: loadSessionProgress(),
    feedbackSettings: loadFeedbackSettings(),
  };

  init();

  async function init() {
    wireEvents();
    setPhase("加载题库");
    setTimerLabel("--");
    setButtons();

    try {
      const response = await fetch("/api/items", { cache: "no-store" });
      if (!response.ok) {
        throw new Error(`题库读取失败：${response.status}`);
      }

      state.dataset = await response.json();
      applySavedModePreference();
      applyFeedbackSettings();
      elements.dataSummary.textContent = `已载入 ${state.dataset.items.length} 题，来源于你桌面的音频和答案文件。`;
      hydrateQueue();
      renderMistakeBook();
      renderCurrentQuestion();
      renderResumeInfo();
      renderWarnings();
      setPhase("等待开始");
    } catch (error) {
      elements.dataSummary.textContent = error.message;
      elements.resultSummary.textContent = "题库读取失败，请检查服务端窗口里的报错信息。";
      setPhase("载入失败");
    }
  }

  function wireEvents() {
    elements.startButton.addEventListener("click", startSession);
    elements.startMistakesButton.addEventListener("click", startMistakeSession);
    elements.resumeButton.addEventListener("click", resumeSession);
    elements.jumpButton.addEventListener("click", handleJumpRequest);
    elements.playButton.addEventListener("click", () => {
      if (!getCurrentItem()) {
        return;
      }
      playCurrentQuestion();
    });
    elements.submitButton.addEventListener("click", () => gradeCurrentAnswer("manual"));
    elements.retryButton.addEventListener("click", retryCurrentQuestion);
    elements.nextButton.addEventListener("click", goToNextQuestion);

    elements.practiceMode.addEventListener("change", () => {
      hydrateQueue();
      renderCurrentQuestion();
      renderResumeInfo();
    });

    elements.answerSeconds.addEventListener("change", () => {
      const value = clampNumber(Number(elements.answerSeconds.value), 5, 60);
      elements.answerSeconds.value = String(value);
    });

    elements.soundEnabled.addEventListener("change", () => {
      state.feedbackSettings.enabled = elements.soundEnabled.checked;
      persistFeedbackSettings();
      applyFeedbackSettings();
      setButtons();
    });

    elements.soundVolume.addEventListener("input", () => {
      const volume = clampNumber(Number(elements.soundVolume.value), 0, 100);
      state.feedbackSettings.volume = volume;
      elements.soundVolume.value = String(volume);
      persistFeedbackSettings();
      applyFeedbackSettings();
    });

    elements.jumpQuestionInput.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") {
        return;
      }
      event.preventDefault();
      handleJumpRequest();
    });

    elements.answerInput.addEventListener("input", () => {
      saveSessionProgress();
      setButtons();
    });
    elements.answerInput.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || event.shiftKey || event.isComposing) {
        return;
      }
      if (!canSubmitCurrentAnswer()) {
        return;
      }
      event.preventDefault();
      gradeCurrentAnswer("manual");
    });
    elements.copyMistakesButton.addEventListener("click", copyMistakeNumbers);
    elements.clearMistakesButton.addEventListener("click", clearMistakeBook);

    state.fallbackAudio.preload = "auto";
    state.fallbackAudio.addEventListener("ended", () => {
      if (state.phase === "播放中") {
        startCountdown();
      }
    });
    state.fallbackAudio.addEventListener("error", () => {
      setPhase("音频加载失败");
      elements.resultSummary.textContent = "浏览器的兼容播放也失败了，请检查音频文件是否完整，然后重试。";
      setButtons();
    });

    Object.values(state.feedbackFallbackAudio).forEach((audio) => {
      audio.preload = "auto";
    });
  }

  function startSession() {
    if (!state.dataset) {
      return;
    }

    clearSessionProgress();
    hydrateQueue();
    if (!state.queue.length) {
      elements.resultSummary.textContent = "当前模式下没有题目可练。你可以先切回“全部题目”。";
      setPhase("无可练题目");
      return;
    }

    openQuestion(0, true);
  }

  function startMistakeSession() {
    if (!state.dataset) {
      return;
    }

    elements.practiceMode.value = "mistakes";
    elements.autoAdvance.checked = true;
    renderResumeInfo();
    clearSessionProgress();
    hydrateQueue();
    renderCurrentQuestion();

    if (!state.queue.length) {
      elements.resultSummary.textContent = "目前错题本是空的，还没有可开始的错题顺练。";
      setPhase("无可练题目");
      return;
    }

    openQuestion(0, true);
    elements.resultSummary.textContent = `已按题号从小到大载入 ${state.queue.length} 道错题，会按顺序往下练。`;
  }

  function resumeSession() {
    if (!state.dataset || !state.sessionProgress) {
      elements.resultSummary.textContent = "目前没有可恢复的上次进度。";
      return;
    }

    if (state.sessionProgress.mode) {
      elements.practiceMode.value = state.sessionProgress.mode;
    }

    hydrateQueue();
    if (!state.queue.length) {
      clearSessionProgress();
      elements.resultSummary.textContent = "上次保存的是错题模式，但当前错题本为空，所以无法继续原进度。";
      return;
    }

    const resumeIndex = resolveResumeIndex();
    if (resumeIndex === -1) {
      clearSessionProgress();
      elements.resultSummary.textContent = "上次保存的题目现在找不到了，已经为你清除旧进度。";
      renderResumeInfo();
      return;
    }

    openQuestion(resumeIndex, false, {
      answerDraft: state.sessionProgress.answerDraft || "",
    });
    elements.resultSummary.textContent = `已恢复到题号 ${state.queue[resumeIndex].id}。你可以直接继续作答或点击播放。`;
  }

  function handleJumpRequest() {
    if (!state.dataset) {
      return;
    }

    const rawValue = elements.jumpQuestionInput.value.trim();
    if (!rawValue) {
      elements.resultSummary.textContent = "先输入你想跳到的题号，再点“跳转”。";
      return;
    }

    const questionId = Number(rawValue);
    if (!Number.isInteger(questionId) || questionId <= 0) {
      elements.resultSummary.textContent = "题号必须是正整数。";
      return;
    }

    jumpToQuestion(questionId, { announce: true });
  }

  function hydrateQueue() {
    clearAdvanceTimer();
    clearCountdown();
    stopAudio();

    const mode = elements.practiceMode.value;
    const allItems = state.dataset ? state.dataset.items : [];
    if (mode === "mistakes") {
      const numbers = getSortedMistakeNumbers();
      state.queue = numbers
        .map((number) => allItems.find((item) => item.id === number))
        .filter(Boolean);
    } else {
      state.queue = [...allItems];
    }

    state.queueIndex = state.queue.length ? 0 : -1;
    state.currentEvaluation = null;
    elements.answerInput.value = "";
    elements.answerInput.disabled = true;
    setButtons();
  }

  function openQuestion(index, autoplay, options = {}) {
    clearAdvanceTimer();
    clearCountdown();
    stopAudio();

    state.queueIndex = index;
    state.currentEvaluation = null;
    elements.answerInput.value = options.answerDraft || "";
    elements.answerInput.disabled = false;
    renderCurrentQuestion();
    resetReview("正在准备本题…");
    saveSessionProgress();
    renderResumeInfo();
    preloadAroundQuestion(index);
    primeFallbackAudio(state.queue[index]);

    if (autoplay) {
      playCurrentQuestion();
    } else {
      setPhase("等待播放");
      setButtons();
    }
  }

  async function playCurrentQuestion() {
    const item = getCurrentItem();
    if (!item) {
      return;
    }

    clearAdvanceTimer();
    clearCountdown();
    stopAudio();

    elements.answerInput.disabled = false;
    elements.answerInput.focus();

    setPhase("加载音频");
    setTimerLabel("正在缓冲");
    setButtons();

    const playbackToken = state.playbackToken;

    try {
      const context = await ensureAudioContext();
      preloadFeedbackAudio();
      const buffer = await prepareAudioBuffer(item);
      if (playbackToken !== state.playbackToken) {
        return;
      }

      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(context.destination);
      source.onended = () => {
        if (state.currentSource === source) {
          state.currentSource = null;
        }
        if (playbackToken === state.playbackToken && state.phase === "播放中") {
          startCountdown();
        }
      };

      state.currentSource = source;
      source.start(0);
      setPhase("播放中");
      setTimerLabel("音频播放中");
      setButtons();
      preloadAroundQuestion(state.queueIndex + 1);
    } catch (error) {
      if (playbackToken !== state.playbackToken) {
        return;
      }
      console.error(error);
      playWithFallbackAudio(item, playbackToken);
    }
  }

  async function ensureAudioContext() {
    if (!state.audioContext) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) {
        throw new Error("This browser does not support Web Audio.");
      }
      state.audioContext = new AudioContextClass();
    }

    if (state.audioContext.state === "suspended") {
      await state.audioContext.resume();
    }

    return state.audioContext;
  }

  async function prepareAudioBuffer(item) {
    if (state.audioBuffers.has(item.id)) {
      return state.audioBuffers.get(item.id);
    }

    if (state.audioLoads.has(item.id)) {
      return state.audioLoads.get(item.id);
    }

    const loadPromise = (async () => {
      const context = await ensureAudioContext();
      const response = await fetch(item.audioUrl, { cache: "force-cache" });
      if (!response.ok) {
        throw new Error(`Audio fetch failed: ${response.status}`);
      }

      const arrayBuffer = await response.arrayBuffer();
      const decoded = await decodeAudioData(context, arrayBuffer);
      const prepared = prependPreroll(context, decoded, AUDIO_PREROLL_SECONDS);
      state.audioBuffers.set(item.id, prepared);
      return prepared;
    })();

    state.audioLoads.set(item.id, loadPromise);

    try {
      return await loadPromise;
    } finally {
      state.audioLoads.delete(item.id);
    }
  }

  function preloadAroundQuestion(index) {
    const current = state.queue[index];
    const next = state.queue[index + 1];
    [current, next].filter(Boolean).forEach((item) => {
      prepareAudioBuffer(item).catch(() => {
        // Ignore preload failures here; playCurrentQuestion handles visible errors.
      });
    });
  }

  function preloadFeedbackAudio() {
    prepareFeedbackBuffer("correct").catch(() => {
      // Ignore preload failures here; fallback playback still exists.
    });
    prepareFeedbackBuffer("wrong").catch(() => {
      // Ignore preload failures here; fallback playback still exists.
    });
  }

  function primeFallbackAudio(item) {
    if (!item || state.fallbackPrimedId === item.id) {
      return;
    }

    state.fallbackAudio.src = item.audioUrl;
    state.fallbackAudio.load();
    state.fallbackPrimedId = item.id;
  }

  function playWithFallbackAudio(item, playbackToken) {
    try {
      primeFallbackAudio(item);
      state.fallbackAudio.currentTime = 0;
      const playPromise = state.fallbackAudio.play();
      setPhase("播放中");
      setTimerLabel("音频播放中");
      elements.resultSummary.textContent = "已切换到兼容播放模式。";
      setButtons();

      if (playPromise && typeof playPromise.catch === "function") {
        playPromise.catch((error) => {
          if (playbackToken !== state.playbackToken) {
            return;
          }
          console.error(error);
          setPhase("音频加载失败");
          elements.resultSummary.textContent = "浏览器阻止了兼容播放，请再点一次“播放当前题”。";
          setButtons();
        });
      }
    } catch (error) {
      if (playbackToken !== state.playbackToken) {
        return;
      }
      console.error(error);
      setPhase("音频加载失败");
      elements.resultSummary.textContent = "音频预加载和兼容播放都失败了，请检查素材文件后重试。";
      setButtons();
    }
  }

  function decodeAudioData(context, arrayBuffer) {
    return new Promise((resolve, reject) => {
      context.decodeAudioData(arrayBuffer.slice(0), resolve, reject);
    });
  }

  function prependPreroll(context, buffer, prerollSeconds) {
    const prerollFrames = Math.max(1, Math.round(buffer.sampleRate * prerollSeconds));
    const totalFrames = buffer.length + prerollFrames;
    const combined = context.createBuffer(buffer.numberOfChannels, totalFrames, buffer.sampleRate);

    for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
      const sourceChannel = buffer.getChannelData(channel);
      const targetChannel = combined.getChannelData(channel);
      targetChannel.set(sourceChannel, prerollFrames);
    }

    return combined;
  }

  function startCountdown() {
    clearCountdown();
    const seconds = clampNumber(Number(elements.answerSeconds.value), 5, 60);
    state.countdownDeadline = Date.now() + seconds * 1000;
    setPhase("倒计时作答");
    tickCountdown();
    state.countdownTimerId = window.setInterval(tickCountdown, 100);
    setButtons();
  }

  function tickCountdown() {
    if (!state.countdownDeadline) {
      return;
    }

    const msLeft = state.countdownDeadline - Date.now();
    if (msLeft <= 0) {
      clearCountdown();
      setTimerLabel("00.0 秒");
      gradeCurrentAnswer("timeout");
      return;
    }
    setTimerLabel(`${(msLeft / 1000).toFixed(1)} 秒`);
  }

  function gradeCurrentAnswer(trigger) {
    const item = getCurrentItem();
    if (!item) {
      return;
    }

    clearCountdown();
    stopAudio();

    const typedText = elements.answerInput.value.trim();
    const evaluation = evaluateAnswer(typedText, item.answer);
    state.currentEvaluation = evaluation;

    if (!evaluation.perfect) {
      upsertMistake(item.id, typedText, evaluation);
    } else if (state.mistakeBook[item.id]) {
      state.mistakeBook[item.id].lastStatus = "corrected";
      state.mistakeBook[item.id].correctAttempts = (state.mistakeBook[item.id].correctAttempts || 0) + 1;
      persistMistakeBook();
    }

    saveSessionProgress();
    renderEvaluation(item, evaluation, trigger);
    playFeedbackSound(evaluation.perfect);
    renderMistakeBook();
    setButtons();

    if (evaluation.perfect && elements.autoAdvance.checked) {
      setPhase("本题全对");
      state.advanceTimerId = window.setTimeout(() => {
        goToNextQuestion();
      }, ADVANCE_DELAY_MS);
    } else {
      setPhase(evaluation.perfect ? "本题全对" : "已判题");
    }
  }

  function retryCurrentQuestion() {
    const item = getCurrentItem();
    if (!item) {
      return;
    }

    clearAdvanceTimer();
    clearCountdown();
    stopAudio();
    elements.answerInput.value = "";
    elements.answerInput.disabled = false;
    resetReview(`已清空第 ${item.id} 题输入，可以重新开始。`);
    saveSessionProgress();
    setPhase("等待播放");
    setButtons();
  }

  function goToNextQuestion() {
    clearAdvanceTimer();

    const nextIndex = state.queueIndex + 1;
    if (nextIndex >= state.queue.length) {
      clearCountdown();
      stopAudio();
      elements.answerInput.disabled = true;
      clearSessionProgress();
      setPhase("本轮完成");
      setTimerLabel("--");
      elements.resultSummary.textContent = "这一轮已经练完了。你可以切到“只练错题”，或者重新开始整套题。";
      setButtons();
      return;
    }

    openQuestion(nextIndex, true);
  }

  function renderWarnings() {
    if (!state.dataset) {
      return;
    }

    const missingAudio = state.dataset.warnings.missingAudio || [];
    const missingAnswers = state.dataset.warnings.missingAnswers || [];
    if (missingAudio.length || missingAnswers.length) {
      const notes = [];
      if (missingAudio.length) {
        notes.push(`缺少音频题号：${missingAudio.join(", ")}`);
      }
      if (missingAnswers.length) {
        notes.push(`缺少答案题号：${missingAnswers.join(", ")}`);
      }
      elements.dataSummary.textContent += ` 另有提示：${notes.join("；")}。`;
    }
  }

  function renderResumeInfo() {
    const progress = state.sessionProgress;
    if (!progress) {
      elements.resumeSummary.textContent = "目前没有未完成进度。";
      return;
    }

    const modeLabel = progress.mode === "mistakes" ? "只练错题" : "全部题目";
    const draftHint = progress.answerDraft ? " 已保留你上次输入的草稿。" : "";
    elements.resumeSummary.textContent = `检测到上次在“${modeLabel}”模式练到题号 ${progress.questionId}。${draftHint}`;
  }

  function renderCurrentQuestion() {
    const item = getCurrentItem();
    const total = state.queue.length;

    if (!item) {
      elements.questionLabel.textContent = "暂无题目";
      elements.answerInput.disabled = true;
      setTimerLabel("--");
      resetReview("切换模式后当前没有题目可练。");
      setButtons();
      return;
    }

    elements.questionLabel.textContent = `第 ${state.queueIndex + 1} / ${total} 题 · 题号 ${item.id}`;
    if (!state.currentEvaluation) {
      resetReview("播放并提交后，这里会显示逐词对比。");
    }
    setButtons();
  }

  function renderEvaluation(item, evaluation, trigger) {
    const triggerText = trigger === "timeout" ? "时间到自动收卷" : "已完成判题";
    const correctWords = `${evaluation.correctWordCount}/${evaluation.totalWordCount}`;

    elements.resultSummary.textContent = evaluation.perfect
      ? `${triggerText}。第 ${item.id} 题全部词汇正确，${elements.autoAdvance.checked ? "即将自动进入下一题。" : "你可以手动进入下一题。"}`
      : `${triggerText}。第 ${item.id} 题正确词数 ${correctWords}，请先看红色高亮位置。`;

    renderTokenLine(elements.expectedTokens, evaluation.ops, "expected");
    renderTokenLine(elements.actualTokens, evaluation.ops, "actual");
    renderIssueList(evaluation.issues, elements.issueList, "这题没有词汇错误。");
    renderIssueList(evaluation.formatNotes, elements.formatList, "没有额外的格式提醒。");
  }

  function renderTokenLine(container, ops, side) {
    container.innerHTML = "";
    container.classList.remove("empty-state");

    ops.forEach((op) => {
      if (side === "expected") {
        if (op.type === "insert") {
          return;
        }
        const tokenText = op.expected ? op.expected.raw : "∅";
        const token = createToken(tokenText, op.type === "match" ? "token-correct" : "token-expected-error");
        container.appendChild(token);
        return;
      }

      if (op.type === "delete") {
        container.appendChild(createToken("∅", "token-missing"));
        return;
      }

      const tokenText = op.actual ? op.actual.raw : "∅";
      const tokenClass = op.type === "match" ? "token-correct" : "token-actual-error";
      container.appendChild(createToken(tokenText, tokenClass));
    });
  }

  function createToken(text, extraClass) {
    const span = document.createElement("span");
    span.className = `token ${extraClass}`;
    span.textContent = text;
    return span;
  }

  function renderIssueList(items, container, emptyText) {
    container.innerHTML = "";
    if (!items.length) {
      const li = document.createElement("li");
      li.className = "empty-line";
      li.textContent = emptyText;
      container.appendChild(li);
      return;
    }

    items.forEach((item) => {
      const li = document.createElement("li");
      li.textContent = item.message;
      container.appendChild(li);
    });
  }

  function renderMistakeBook() {
    const entries = Object.entries(state.mistakeBook)
      .map(([id, value]) => ({ id: Number(id), ...value }))
      .sort((left, right) => left.id - right.id);

    elements.mistakeCountLabel.textContent = `${entries.length} 题`;
    elements.mistakeList.innerHTML = "";

    if (!entries.length) {
      const empty = document.createElement("p");
      empty.className = "empty-line";
      empty.textContent = "目前还没有记录到错题。";
      elements.mistakeList.appendChild(empty);
      return;
    }

    entries.forEach((entry) => {
      const wrapper = document.createElement("article");
      wrapper.className = "mistake-item";

      const top = document.createElement("div");
      top.className = "mistake-item-top";

      const index = document.createElement("span");
      index.className = "mistake-index";
      index.textContent = `题号 ${entry.id}`;

      const status = document.createElement("span");
      status.textContent = entry.lastStatus === "corrected" ? "最近一次已改对" : "最近一次仍有错误";

      top.appendChild(index);
      top.appendChild(status);

      const meta = document.createElement("p");
      meta.className = "mistake-meta";
      meta.textContent = `错了 ${entry.wrongAttempts} 次，最近输入：${entry.lastInput || "（空白）"}`;

      const jumpButton = document.createElement("button");
      jumpButton.className = "secondary-button";
      jumpButton.textContent = "跳到这题";
      jumpButton.addEventListener("click", () => jumpToQuestion(entry.id));

      const removeButton = document.createElement("button");
      removeButton.className = "ghost-button danger-button";
      removeButton.textContent = "移出记录";
      removeButton.addEventListener("click", () => removeMistakeRecord(entry.id));

      const actions = document.createElement("div");
      actions.className = "mistake-actions";
      actions.appendChild(jumpButton);
      actions.appendChild(removeButton);

      wrapper.appendChild(top);
      wrapper.appendChild(meta);
      wrapper.appendChild(actions);
      elements.mistakeList.appendChild(wrapper);
    });
  }

  function jumpToQuestion(questionId, options = {}) {
    if (!state.dataset) {
      return false;
    }

    let index = state.queue.findIndex((item) => item.id === questionId);
    let switchedMode = false;

    if (index === -1) {
      elements.practiceMode.value = "all";
      hydrateQueue();
      index = state.queue.findIndex((item) => item.id === questionId);
      switchedMode = true;
    }

    if (index === -1) {
      const maxQuestionId = state.dataset.items.reduce((max, item) => Math.max(max, item.id), 0);
      elements.resultSummary.textContent = `找不到题号 ${questionId}。请输入 1 到 ${maxQuestionId} 之间的题号。`;
      return false;
    }

    openQuestion(index, false);
    elements.jumpQuestionInput.value = String(questionId);

    if (options.announce !== false) {
      const modeText = switchedMode ? " 已自动切换到“全部题目”模式。" : "";
      elements.resultSummary.textContent = `已跳转到题号 ${questionId}。${modeText}`;
    }

    return true;
  }

  function copyMistakeNumbers() {
    const numbers = getSortedMistakeNumbers();

    if (!numbers.length) {
      elements.resultSummary.textContent = "错题本还是空的，目前没有可复制的题号。";
      return;
    }

    const text = numbers.join(", ");
    navigator.clipboard.writeText(text).then(
      () => {
        elements.resultSummary.textContent = `已复制错题题号：${text}`;
      },
      () => {
        elements.resultSummary.textContent = `复制失败。你可以手动记录这些题号：${text}`;
      }
    );
  }

  function clearMistakeBook() {
    if (!window.confirm("确定要清空错题本吗？这会删除当前浏览器里记录的错题题号。")) {
      return;
    }

    state.mistakeBook = {};
    persistMistakeBook();
    hydrateQueue();
    renderCurrentQuestion();
    renderMistakeBook();
    elements.resultSummary.textContent = "错题本已清空。";
  }

  function removeMistakeRecord(questionId) {
    if (!state.mistakeBook[questionId]) {
      elements.resultSummary.textContent = `题号 ${questionId} 当前不在错题记录里。`;
      return;
    }

    if (!window.confirm(`确定把题号 ${questionId} 从错题记录中移出吗？`)) {
      return;
    }

    const currentItem = getCurrentItem();
    const currentQuestionId = currentItem ? currentItem.id : null;
    const currentDraft = elements.answerInput.value;
    const previousIndex = state.queueIndex;

    delete state.mistakeBook[questionId];
    persistMistakeBook();
    renderMistakeBook();

    if (elements.practiceMode.value !== "mistakes") {
      elements.resultSummary.textContent = `题号 ${questionId} 已从错题记录中移出。`;
      setButtons();
      return;
    }

    hydrateQueue();

    if (!state.queue.length) {
      renderCurrentQuestion();
      elements.resultSummary.textContent = "这道题已经移出，当前错题本也已经空了。";
      return;
    }

    let targetIndex = -1;
    let draftToKeep = "";

    if (currentQuestionId !== null && currentQuestionId !== questionId) {
      targetIndex = state.queue.findIndex((item) => item.id === currentQuestionId);
      if (targetIndex !== -1) {
        draftToKeep = currentDraft;
      }
    }

    if (targetIndex === -1) {
      targetIndex = Math.min(previousIndex, state.queue.length - 1);
    }

    openQuestion(targetIndex, false, {
      answerDraft: draftToKeep,
    });

    if (currentQuestionId === questionId) {
      elements.resultSummary.textContent = `题号 ${questionId} 已移出错题记录，已为你切到下一道错题。`;
    } else {
      elements.resultSummary.textContent = `题号 ${questionId} 已从错题记录中移出。`;
    }
  }

  function upsertMistake(questionId, typedText, evaluation) {
    const existing = state.mistakeBook[questionId] || {
      wrongAttempts: 0,
      correctAttempts: 0,
    };

    state.mistakeBook[questionId] = {
      wrongAttempts: existing.wrongAttempts + 1,
      correctAttempts: existing.correctAttempts || 0,
      lastInput: typedText,
      lastStatus: evaluation.perfect ? "corrected" : "wrong",
      lastUpdatedAt: new Date().toISOString(),
    };
    persistMistakeBook();
  }

  function persistMistakeBook() {
    window.localStorage.setItem(MISTAKE_STORAGE_KEY, JSON.stringify(state.mistakeBook));
  }

  function loadMistakeBook() {
    try {
      const raw = window.localStorage.getItem(MISTAKE_STORAGE_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch (error) {
      return {};
    }
  }

  function getSortedMistakeNumbers() {
    return Object.keys(state.mistakeBook)
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value > 0)
      .sort((left, right) => left - right);
  }

  function saveSessionProgress() {
    const item = getCurrentItem();
    if (!item) {
      return;
    }

    state.sessionProgress = {
      mode: elements.practiceMode.value,
      questionId: item.id,
      answerDraft: elements.answerInput.value,
      updatedAt: new Date().toISOString(),
    };
    window.localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(state.sessionProgress));
    renderResumeInfo();
    setButtons();
  }

  function clearSessionProgress() {
    state.sessionProgress = null;
    window.localStorage.removeItem(SESSION_STORAGE_KEY);
    renderResumeInfo();
    setButtons();
  }

  function loadSessionProgress() {
    try {
      const raw = window.localStorage.getItem(SESSION_STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (error) {
      return null;
    }
  }

  function loadFeedbackSettings() {
    try {
      const raw = window.localStorage.getItem(FEEDBACK_SETTINGS_KEY);
      if (!raw) {
        return { enabled: true, volume: 45 };
      }

      const parsed = JSON.parse(raw);
      return {
        enabled: parsed.enabled !== false,
        volume: clampNumber(Number(parsed.volume), 0, 100),
      };
    } catch (error) {
      return { enabled: true, volume: 45 };
    }
  }

  function persistFeedbackSettings() {
    window.localStorage.setItem(FEEDBACK_SETTINGS_KEY, JSON.stringify(state.feedbackSettings));
  }

  function applyFeedbackSettings() {
    const volume = clampNumber(Number(state.feedbackSettings.volume), 0, 100);
    const enabled = state.feedbackSettings.enabled !== false;
    const normalizedVolume = volume / 100;

    state.feedbackSettings = {
      enabled,
      volume,
    };

    elements.soundEnabled.checked = enabled;
    elements.soundVolume.value = String(volume);
    elements.soundVolumeLabel.textContent = `${volume}%`;

    Object.values(state.feedbackFallbackAudio).forEach((audio) => {
      audio.volume = normalizedVolume;
      audio.muted = !enabled;
    });

    if (!enabled || normalizedVolume === 0) {
      stopFeedbackSound();
    }
  }

  async function playFeedbackSound(isPerfect) {
    if (!state.feedbackSettings.enabled) {
      return;
    }

    const soundKind = isPerfect ? "correct" : "wrong";
    const normalizedVolume = clampNumber(Number(state.feedbackSettings.volume), 0, 100) / 100;
    if (normalizedVolume === 0) {
      return;
    }

    try {
      const context = await ensureAudioContext();
      const buffer = await prepareFeedbackBuffer(soundKind);
      stopFeedbackSound();

      const source = context.createBufferSource();
      const gainNode = context.createGain();
      gainNode.gain.value = normalizedVolume;
      source.buffer = buffer;
      source.connect(gainNode);
      gainNode.connect(context.destination);
      source.onended = () => {
        if (state.currentFeedbackSource === source) {
          state.currentFeedbackSource = null;
        }
      };

      state.currentFeedbackSource = source;
      source.start(0);
    } catch (error) {
      playFeedbackWithFallback(soundKind);
    }
  }

  async function prepareFeedbackBuffer(soundKind) {
    if (state.feedbackBuffers.has(soundKind)) {
      return state.feedbackBuffers.get(soundKind);
    }

    if (state.feedbackLoads.has(soundKind)) {
      return state.feedbackLoads.get(soundKind);
    }

    const audioUrl = FEEDBACK_AUDIO_URLS[soundKind];
    const loadPromise = (async () => {
      const context = await ensureAudioContext();
      const response = await fetch(audioUrl, { cache: "force-cache" });
      if (!response.ok) {
        throw new Error(`Feedback audio fetch failed: ${response.status}`);
      }

      const arrayBuffer = await response.arrayBuffer();
      const decoded = await decodeAudioData(context, arrayBuffer);
      state.feedbackBuffers.set(soundKind, decoded);
      return decoded;
    })();

    state.feedbackLoads.set(soundKind, loadPromise);

    try {
      return await loadPromise;
    } finally {
      state.feedbackLoads.delete(soundKind);
    }
  }

  function stopFeedbackSound() {
    if (state.currentFeedbackSource) {
      try {
        state.currentFeedbackSource.stop();
      } catch (error) {
        // Ignore stop failures for already-ended sources.
      }
      state.currentFeedbackSource = null;
    }

    Object.values(state.feedbackFallbackAudio).forEach((audio) => {
      audio.pause();
      audio.currentTime = 0;
    });
  }

  function playFeedbackWithFallback(soundKind) {
    const audio = state.feedbackFallbackAudio[soundKind];
    if (!audio) {
      return;
    }

    stopFeedbackSound();

    try {
      const playPromise = audio.play();
      if (playPromise && typeof playPromise.catch === "function") {
        playPromise.catch(() => {
          // Ignore autoplay-related failures for non-essential feedback sounds.
        });
      }
    } catch (error) {
      // Ignore feedback sound failures so they never block grading.
    }
  }

  function applySavedModePreference() {
    if (!state.sessionProgress || !state.sessionProgress.mode) {
      return;
    }

    const mode = state.sessionProgress.mode;
    if (mode === "all" || mode === "mistakes") {
      elements.practiceMode.value = mode;
    }
  }

  function resolveResumeIndex() {
    if (!state.sessionProgress) {
      return -1;
    }

    return state.queue.findIndex((item) => item.id === state.sessionProgress.questionId);
  }

  function evaluateAnswer(actualText, expectedText) {
    const expectedWords = tokenizeWords(expectedText);
    const actualWords = tokenizeWords(actualText);
    const ops = alignWords(expectedWords, actualWords);
    const issues = [];
    let correctWordCount = 0;

    ops.forEach((op) => {
      if (op.type === "match") {
        correctWordCount += 1;
        return;
      }
      if (op.type === "delete") {
        issues.push({ message: `漏写了 “${op.expected.raw}”` });
        return;
      }
      if (op.type === "insert") {
        issues.push({ message: `多写了 “${op.actual.raw}”` });
        return;
      }

      const expectedWord = op.expected.raw;
      const actualWord = op.actual.raw;
      const distance = levenshtein(op.expected.norm, op.actual.norm);
      if (distance <= 2) {
        issues.push({ message: `“${actualWord}” 拼写不对，应为 “${expectedWord}”` });
      } else {
        issues.push({ message: `“${expectedWord}” 被写成了 “${actualWord}”` });
      }
    });

    const formatNotes = [];
    if (actualText && /^[a-z]/.test(actualText)) {
      formatNotes.push({ message: "首字母建议大写，和正式考试习惯保持一致。" });
    }
    if (/\s{2,}/.test(actualText)) {
      formatNotes.push({ message: "你的输入里有连续空格，提交前最好顺手检查一下。" });
    }

    const perfect =
      expectedWords.length === actualWords.length &&
      ops.every((op) => op.type === "match");

    return {
      perfect,
      ops,
      issues,
      formatNotes,
      correctWordCount,
      totalWordCount: expectedWords.length,
    };
  }

  function alignWords(expectedWords, actualWords) {
    const rows = expectedWords.length + 1;
    const cols = actualWords.length + 1;
    const dp = Array.from({ length: rows }, () => Array(cols).fill(0));
    const backtrack = Array.from({ length: rows }, () => Array(cols).fill(null));

    for (let i = rows - 1; i >= 0; i -= 1) {
      for (let j = cols - 1; j >= 0; j -= 1) {
        if (i === expectedWords.length && j === actualWords.length) {
          dp[i][j] = 0;
          continue;
        }

        const candidates = [];

        if (i < expectedWords.length && j < actualWords.length) {
          const isMatch = expectedWords[i].norm === actualWords[j].norm;
          candidates.push({
            cost: (isMatch ? 0 : 1) + dp[i + 1][j + 1],
            move: isMatch ? "match" : "substitute",
          });
        }

        if (i < expectedWords.length) {
          candidates.push({
            cost: 1 + dp[i + 1][j],
            move: "delete",
          });
        }

        if (j < actualWords.length) {
          candidates.push({
            cost: 1 + dp[i][j + 1],
            move: "insert",
          });
        }

        candidates.sort((left, right) => {
          if (left.cost !== right.cost) {
            return left.cost - right.cost;
          }
          const priority = { match: 0, substitute: 1, delete: 2, insert: 3 };
          return priority[left.move] - priority[right.move];
        });

        dp[i][j] = candidates[0].cost;
        backtrack[i][j] = candidates[0].move;
      }
    }

    const ops = [];
    let i = 0;
    let j = 0;
    while (i < expectedWords.length || j < actualWords.length) {
      const move = backtrack[i][j];
      if (move === "match") {
        ops.push({ type: "match", expected: expectedWords[i], actual: actualWords[j] });
        i += 1;
        j += 1;
      } else if (move === "substitute") {
        ops.push({ type: "substitute", expected: expectedWords[i], actual: actualWords[j] });
        i += 1;
        j += 1;
      } else if (move === "delete") {
        ops.push({ type: "delete", expected: expectedWords[i], actual: null });
        i += 1;
      } else if (move === "insert") {
        ops.push({ type: "insert", expected: null, actual: actualWords[j] });
        j += 1;
      } else {
        break;
      }
    }

    return ops;
  }

  function tokenizeWords(text) {
    const matches = text.match(/[A-Za-z0-9]+(?:['-][A-Za-z0-9]+)*/g) || [];
    return matches.map((raw, index) => ({
      raw,
      norm: raw.toLowerCase(),
      index,
    }));
  }

  function levenshtein(left, right) {
    const rows = left.length + 1;
    const cols = right.length + 1;
    const matrix = Array.from({ length: rows }, () => Array(cols).fill(0));

    for (let i = 0; i < rows; i += 1) {
      matrix[i][0] = i;
    }
    for (let j = 0; j < cols; j += 1) {
      matrix[0][j] = j;
    }

    for (let i = 1; i < rows; i += 1) {
      for (let j = 1; j < cols; j += 1) {
        const cost = left[i - 1] === right[j - 1] ? 0 : 1;
        matrix[i][j] = Math.min(
          matrix[i - 1][j] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j - 1] + cost
        );
      }
    }

    return matrix[left.length][right.length];
  }

  function resetReview(summaryText) {
    elements.resultSummary.textContent = summaryText;
    elements.expectedTokens.textContent = "播放并提交后显示";
    elements.actualTokens.textContent = "播放并提交后显示";
    elements.expectedTokens.classList.add("empty-state");
    elements.actualTokens.classList.add("empty-state");
    renderIssueList([], elements.issueList, "当前还没有错误信息。");
    renderIssueList([], elements.formatList, "这里会提醒大小写和标点等细节。");
  }

  function setButtons() {
    const hasItem = Boolean(getCurrentItem());
    elements.startButton.disabled = !state.dataset;
    elements.startMistakesButton.disabled = !state.dataset || !getSortedMistakeNumbers().length;
    elements.resumeButton.disabled = !state.dataset || !state.sessionProgress;
    elements.playButton.disabled = !hasItem;
    elements.submitButton.disabled = !canSubmitCurrentAnswer();
    elements.retryButton.disabled = !hasItem;
    elements.nextButton.disabled = !hasItem;
  }

  function canSubmitCurrentAnswer() {
    const hasItem = Boolean(getCurrentItem());
    const answerFilled = Boolean(elements.answerInput.value.trim());
    return (
      hasItem &&
      (state.phase === "播放中" || state.phase === "倒计时作答") &&
      answerFilled
    );
  }

  function setPhase(label) {
    state.phase = label;
    elements.phaseLabel.textContent = label;
    setButtons();
  }

  function setTimerLabel(text) {
    elements.timerLabel.textContent = text;
  }

  function clearCountdown() {
    if (state.countdownTimerId) {
      window.clearInterval(state.countdownTimerId);
      state.countdownTimerId = null;
    }
    state.countdownDeadline = null;
  }

  function clearAdvanceTimer() {
    if (state.advanceTimerId) {
      window.clearTimeout(state.advanceTimerId);
      state.advanceTimerId = null;
    }
  }

  function stopAudio() {
    state.playbackToken += 1;
    state.fallbackAudio.pause();
    try {
      state.fallbackAudio.currentTime = 0;
    } catch (error) {
      // Ignore currentTime reset failures on unloaded media.
    }
    if (!state.currentSource) {
      return;
    }

    const source = state.currentSource;
    state.currentSource = null;
    source.onended = null;
    try {
      source.stop(0);
    } catch (error) {
      // Ignore stop races when the source has already finished.
    }
  }

  function getCurrentItem() {
    if (state.queueIndex < 0 || state.queueIndex >= state.queue.length) {
      return null;
    }
    return state.queue[state.queueIndex];
  }

  function clampNumber(value, min, max) {
    if (!Number.isFinite(value)) {
      return min;
    }
    return Math.min(max, Math.max(min, Math.round(value)));
  }
})();
