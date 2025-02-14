import * as core from '@actions/core'
import {
  BaseMessage,
  HumanMessage,
  SystemMessage
} from '@langchain/core/messages'
import { END, START, StateGraph } from '@langchain/langgraph'
import { MemorySaver, Annotation } from '@langchain/langgraph'
import { ChatGroq } from '@langchain/groq'
import { ChatGoogleGenerativeAI } from '@langchain/google-genai'
import { BaseChatModel } from '@langchain/core/language_models/chat_models'
import { exit } from 'process'
import {
  getAuthenticatedUserLogin,
  getFileContent,
  getListFiles,
  getListReviewComments,
  getPullRequestContext,
  isNeedToReplyReviewComments,
  isNeedToReviewPullRequest,
  replyToReviewComment,
  submitReview
} from './github'
import { z } from 'zod'
import { PullRequestReviewComment } from './types'
import { tool } from '@langchain/core/tools'
import { knowledgeBaseTools, knowledgeBaseToolsNode } from './llm_tools'
import { wait } from './utils'
import { CallbackManager } from '@langchain/core/callbacks/manager'

const AI_PROVIDER = core.getInput('ai_provider', {
  required: true,
  trimWhitespace: true
})
const AI_PROVIDER_MODEL = core.getInput('ai_provider_model', {
  required: true,
  trimWhitespace: true
})
const CODEBASE_HIGH_OVERVIEW_DESCRIPTION = core.getInput(
  'codebase_high_overview_descripton',
  {
    required: true,
    trimWhitespace: false
  }
)
const GOOGLE_GEMINI_API_KEY = core.getInput('GOOGLE_GEMINI_API_KEY', {
  required: false,
  trimWhitespace: true
})
const GROQ_API_KEY = core.getInput('GROQ_API_KEY', {
  required: false,
  trimWhitespace: true
})

const AI_PROVIDER_GROQ = 'GROQ'
const AI_PROVIDER_GEMINI = 'GEMINI'

const FILE_CHANGES_PATCH_TEXT_LIMIT = 10000
const FULL_SOURCE_CODE_TEXT_LIMIT = 10000

const StateAnnotation = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: (x, y) => x.concat(y),
    default: () => [
      new SystemMessage(
        'You are an AI Assistant that help human to do code review. Please follow instructions given by Human.'
      )
    ]
  }),
  comments: Annotation<PullRequestReviewComment[]>({
    reducer: (x, y) => x.concat(y),
    default: () => []
  })
})

const MODEL_COSTS = {
  'gemini-1.5-pro': {
    input: 0.00025, // per 1K input tokens
    output: 0.0005 // per 1K output tokens
  },
  'gemini-1.5-flash': {
    input: 0.0001, // per 1K input tokens
    output: 0.0002 // per 1K output tokens
  },
  'mixtral-8x7b-32768': {
    input: 0.0027, // per 1K input tokens
    output: 0.0027 // per 1K output tokens
  }
} as const

interface CostTracker {
  inputTokens: number
  outputTokens: number
  totalCost: number
}

let costTracker: CostTracker = {
  inputTokens: 0,
  outputTokens: 0,
  totalCost: 0
}

function getModel(): BaseChatModel {
  let model: BaseChatModel | undefined

  const callbacks = CallbackManager.fromHandlers({
    handleLLMEnd: async (output, runId, parentRunId, tags) => {
      const modelName = output.llmOutput?.modelName || AI_PROVIDER_MODEL
      const costs = MODEL_COSTS[modelName as keyof typeof MODEL_COSTS]

      core.info(`Model: ${modelName}`)

      const inputTokens =
        output.llmOutput?.promptTokenCount ||
        output.llmOutput?.tokenUsage?.promptTokens ||
        (output.generations?.[0] as any)?.tokenUsage?.promptTokens ||
        0

      const outputTokens =
        output.llmOutput?.completionTokenCount ||
        output.llmOutput?.tokenUsage?.completionTokens ||
        (output.generations?.[0] as any)?.tokenUsage?.completionTokens ||
        0

      if (costs) {
        const inputCost = (inputTokens * costs.input) / 1000
        const outputCost = (outputTokens * costs.output) / 1000

        costTracker.inputTokens += inputTokens
        costTracker.outputTokens += outputTokens
        costTracker.totalCost += inputCost + outputCost

        core.info(`[Cost Tracking] Model: ${modelName}`)
        core.info(`Input Tokens: ${inputTokens}`)
        core.info(`Output Tokens: ${outputTokens}`)
        core.info(`Cost for this call: $${(inputCost + outputCost).toFixed(4)}`)
        core.info(`Total cost so far: $${costTracker.totalCost.toFixed(4)}`)
      }
    }
  })

  if (AI_PROVIDER === AI_PROVIDER_GROQ && GROQ_API_KEY) {
    model = new ChatGroq({
      model: AI_PROVIDER_MODEL,
      temperature: 0,
      maxTokens: undefined,
      maxRetries: 2,
      apiKey: GROQ_API_KEY,
      callbacks: callbacks
    })
  } else if (AI_PROVIDER === AI_PROVIDER_GEMINI && GOOGLE_GEMINI_API_KEY) {
    model = new ChatGoogleGenerativeAI({
      model: AI_PROVIDER_MODEL,
      apiKey: GOOGLE_GEMINI_API_KEY,
      temperature: 0,
      maxRetries: 2,
      callbacks: callbacks
    })
  } else {
    core.setFailed(`API KEY for provider: ${AI_PROVIDER} is not provided!`)
    exit(1)
  }

  return model
}

async function inputUnderstandingAgentNode(
  _state: typeof StateAnnotation.State
): Promise<{ messages: BaseMessage[] } | undefined> {
  core.info('[LLM] - Understanding the input...')

  const pullRequestContext = await getPullRequestContext()

  // Calculate input tokens
  const promptTemplate = `Please answer these questions under two sections based on given repository informations:
- Understanding given repository information (e.g README file, folder structure, etc.)
- What framework is used?
- What kind of coding styles are used?
- What design patterns are used?
- Understanding given pull request information
- What's the intention of the pull request?
- What kind of changes introduced in this pull request?
- What's the impact of this pull request?
- Understanding the business / domain logic context?
- What's the high overview of the business / domain in this repository?
- What's the high overview about the business / domain logic?`

  const inputTokens = estimateTokens(
    promptTemplate + CODEBASE_HIGH_OVERVIEW_DESCRIPTION + pullRequestContext
  )
  const inputCost = calculateCost(inputTokens, 'input')

  core.info(`[LLM Cost] Input Understanding - Input Tokens: ${inputTokens}`)
  core.info(
    `[LLM Cost] Input Understanding - Estimated Input Cost: $${inputCost.toFixed(3)}`
  )

  const model = getModel()
  const response = await model.invoke([
    new HumanMessage(`${promptTemplate}

# Codebase High Overview Description
${CODEBASE_HIGH_OVERVIEW_DESCRIPTION}
# Repository and Pull Request Information
${pullRequestContext}`)
  ])

  // Calculate output tokens
  const outputTokens = estimateTokens(response.content as string)
  const outputCost = calculateCost(outputTokens, 'output')

  core.info(`[LLM Cost] Input Understanding - Output Tokens: ${outputTokens}`)
  core.info(
    `[LLM Cost] Input Understanding - Estimated Output Cost: $${outputCost.toFixed(3)}`
  )
  core.info(
    `[LLM Cost] Input Understanding - Total Cost: $${(inputCost + outputCost).toFixed(3)}`
  )

  return { messages: [response] }
}

async function knowledgeUpdatesAgentNode(
  state: typeof StateAnnotation.State
): Promise<{ messages: BaseMessage[] } | undefined> {
  core.info('[LLM] - Updating knowledges...')

  // Calculate input tokens from state messages
  const stateMessagesContent = state.messages.map(msg => msg.content).join('')
  const promptContent =
    'Based on given high overview information about the pull request, please gather needed knowledge updates from the internet by using given tools'

  const inputTokens = estimateTokens(stateMessagesContent + promptContent)
  const inputCost = calculateCost(inputTokens, 'input')

  core.info(`[LLM Cost] Knowledge Updates - Input Tokens: ${inputTokens}`)
  core.info(
    `[LLM Cost] Knowledge Updates - Estimated Input Cost: $${inputCost.toFixed(3)}`
  )

  const model = getModel()
  const modelWithTools = model.bindTools!(knowledgeBaseTools)

  const response = await modelWithTools.invoke([
    ...state.messages,
    new HumanMessage(promptContent)
  ])

  // Calculate output tokens
  const outputTokens = estimateTokens(response.content as string)
  const outputCost = calculateCost(outputTokens, 'output')

  core.info(`[LLM Cost] Knowledge Updates - Output Tokens: ${outputTokens}`)
  core.info(
    `[LLM Cost] Knowledge Updates - Estimated Output Cost: $${outputCost.toFixed(3)}`
  )
  core.info(
    `[LLM Cost] Knowledge Updates - Total Cost: $${(inputCost + outputCost).toFixed(3)}`
  )

  return { messages: [response] }
}

// Helper functions for token and cost calculation
function estimateTokens(text: string): number {
  // Rough estimation: ~4 characters per token
  return Math.ceil(text.length / 4)
}

function calculateCost(tokens: number, type: 'input' | 'output'): number {
  // GPT-4 pricing
  const COST_PER_1K_TOKENS = {
    input: 0.03,
    output: 0.06
  }

  return (tokens / 1000) * COST_PER_1K_TOKENS[type]
}

async function reviewCommentsAgentNode(
  state: typeof StateAnnotation.State
): Promise<
  | {
      comments: PullRequestReviewComment[]
    }
  | undefined
> {
  core.info('[LLM] - Reviewing code changes...')

  const outputSchema = z.object({
    comment: z.string().describe('Your comment to specific file and position.'),
    position: z
      .number()
      .describe(
        'The position in the diff / patch where you want to add a review comment. Note this value is not the same as the line number in the file. The position value equals the number of lines down from the first "@@" hunk header in the file you want to add a comment. The line just below the "@@" line is position 1, the next line is position 2, and so on. The position in the diff continues to increase through lines of whitespace and additional hunks until the beginning of a new file.'
      ),
    skip: z
      .boolean()
      .describe('Set this parameter to true to skip reviewing this change.')
  })

  const model = getModel()
  const finalResponseTool = tool(async () => '', {
    name: 'response',
    description: 'Always respond to the user using this tool.',
    schema: outputSchema
  })
  const modelWithStructuredOutput = model.bindTools!([finalResponseTool])

  const listFiles = await getListFiles()

  const comments: PullRequestReviewComment[] = []

  for (let i = 0; i < listFiles.length; i++) {
    const listFile = listFiles[i]

    core.info(`[LLM] - Reviewing file: ${listFile.filename} ...`)

    const fullFileContent = await getFileContent(listFile.filename)

    const response = await modelWithStructuredOutput.invoke([
      ...state.messages,
      new HumanMessage(`Based on given informations from previous chats / messages, and given information below, please create code review comment. You must call "response" tool to give review,
except the file doesn't need to be reviewed (dist files, generated files, and any other files that don't need to be reviewed.) or the file is already good, no need to comment, lgtm,, in that case, just set skip=true for the tool parameter.

Please note that to determine the position parameter of the tool, you should only refer to the "Changes Patch", not the "Full Source Code". The "Full Source Code" is only
useful to give you the context about the changes, but to determine the position tool parameter, you will have to count the position only based on "Changes Patch". For example:
Given this "Changes Patch":
\`\`\`
@@ -65,7 +65,7 @@ jobs:
         uses: ./
         with:
           ai_provider: 'GEMINI'
-          ai_provider_model: 'gemini-1.5-pro'
+          ai_provider_model: 'gemini-1.5-flash'
           codebase_high_overview_descripton:
             'This repository is an LLM Code Reviewer Github Action that use
             typescript implemented with functional programming.'
\`\`\`
The position in the diff where you want to add a review comment. Note this value is not the same as the line number in the file. The position value equals the number of lines down from the first "@@" hunk header in the file you want to add a comment. The line just below the "@@" line is position 1, the next line is position 2, and so on. The position in the diff continues to increase through lines of whitespace and additional hunks until the beginning of a new file.
If you want to comment on the line \`+          ai_provider_model: 'gemini-1.5-flash'\`. You will have to set position to: 4.

Filename: ${listFile.filename}
Previous Filename: ${listFile.previous_filename}
============ Full Source Code =============
${fullFileContent.substring(0, FULL_SOURCE_CODE_TEXT_LIMIT)}
===========================================
============== Changes Patch ==============
${listFile.patch?.substring(0, FILE_CHANGES_PATCH_TEXT_LIMIT) || ''}
===================================`)
    ])

    if (response.tool_calls?.length) {
      const tool_call_args = response.tool_calls[0].args

      if (!tool_call_args.skip) {
        comments.push({
          comment: tool_call_args.comment,
          position: tool_call_args.position,
          path: listFile.filename
        })
      }
    }

    await wait(1000)
  }

  return { comments }
}

async function reviewSummaryAgentNode(
  state: typeof StateAnnotation.State
): Promise<
  | {
      messages: BaseMessage[]
    }
  | undefined
> {
  core.info(`[LLM] - Submitting review...`)

  const outputSchema = z.object({
    review_summary: z.string().describe('Your PR Review summarization.'),
    review_action: z
      .enum(['APPROVE', 'REQUEST_CHANGES', 'COMMENT'])
      .describe(
        'The review action you want to perform. The review actions include: APPROVE, REQUEST_CHANGES, or COMMENT.'
      )
  })
  const finalResponseTool = tool(async () => '', {
    name: 'response',
    description: 'Always respond to the user using this tool.',
    schema: outputSchema
  })

  const model = getModel()
  const modelWithStructuredOutput = model.bindTools!([finalResponseTool])

  const response = await modelWithStructuredOutput.invoke([
    ...state.messages,
    new HumanMessage(`Please create review summary and define review action type based on given informations provided by previous conversations and given review comments.
You must create review summary, and decide the review action type. You should call "response" tool to give review summary.

Review Comments:
${state.comments.map(
  (comment, idx) => `=========== ${idx + 1} ===========
Filename: ${comment.path}
Position: ${comment.position}
Review Comment: ${comment.comment}
=========================`
)}`)
  ])

  if (response.tool_calls?.length) {
    const tool_call_args = response.tool_calls[0].args
    await submitReview(
      tool_call_args.review_summary,
      state.comments,
      tool_call_args.review_action
    )
  }

  return { messages: [] }
}

async function replyReviewCommentsAgentNode(
  state: typeof StateAnnotation.State
): Promise<
  | {
      messages: BaseMessage[]
    }
  | undefined
> {
  core.info(`[LLM] - Replying review comments...`)

  const githubAuthenticatedUserLogin = await getAuthenticatedUserLogin()
  const listReviewComments = await getListReviewComments()

  const topLevelComments = listReviewComments.filter(
    comment => !comment.in_reply_to_id
  )
  const replies = listReviewComments.filter(comment => !!comment.in_reply_to_id)

  const repliesMap: Record<string, typeof listReviewComments> = {}

  topLevelComments.forEach(comment => {
    repliesMap[comment.id] = []
  })

  replies.forEach(reply => {
    repliesMap[reply.in_reply_to_id!].push(reply)
  })

  const model = getModel()

  for (let i = 0; i < topLevelComments.length; i++) {
    const topLevelComment = topLevelComments[i]

    if (
      topLevelComment.user.login === githubAuthenticatedUserLogin &&
      repliesMap[topLevelComment.id].length
    ) {
      const lastComment =
        repliesMap[topLevelComment.id][
          repliesMap[topLevelComment.id].length - 1
        ]

      if (lastComment.user.login !== githubAuthenticatedUserLogin) {
        const response = await model.invoke([
          ...state.messages,
          new HumanMessage(`Please reply this code review comments conversation:
Diff Hunk:
${topLevelComment.diff_hunk}
Conversations:
- AI: ${topLevelComment.body}
${repliesMap[topLevelComment.id].map(comment => `- ${comment.user.login === githubAuthenticatedUserLogin ? 'AI' : `Human(${comment.user.login})`}: ${comment.body}\n`)}
`)
        ])

        await replyToReviewComment(
          topLevelComment.id,
          response.content as string
        )

        await wait(2000)
      }
    }
  }

  return { messages: [] }
}

const workflow = new StateGraph(StateAnnotation)
  .addNode('input_understanding_agent_node', inputUnderstandingAgentNode)
  .addNode('knowledge_updates_agent_node', knowledgeUpdatesAgentNode)
  .addNode('knowledge_base_tools', knowledgeBaseToolsNode)
  .addNode('review_comments_agent_node', reviewCommentsAgentNode)
  .addNode('review_summary_agent_node', reviewSummaryAgentNode)
  .addNode('reply_review_comments_agent_node', replyReviewCommentsAgentNode)
  .addEdge(START, 'input_understanding_agent_node')
  .addEdge('input_understanding_agent_node', 'knowledge_updates_agent_node')
  .addEdge('knowledge_updates_agent_node', 'knowledge_base_tools')
  .addConditionalEdges(
    'knowledge_base_tools',
    // eslint-disable-next-line
    (_state: typeof StateAnnotation.State) => {
      if (isNeedToReplyReviewComments()) {
        return 'reply_review_comments_agent_node'
      }

      if (isNeedToReviewPullRequest()) {
        return 'review_comments_agent_node'
      }

      return END
    }
  )
  .addConditionalEdges(
    'reply_review_comments_agent_node',
    // eslint-disable-next-line
    (_state: typeof StateAnnotation.State) => {
      if (isNeedToReviewPullRequest()) {
        return 'review_comments_agent_node'
      }

      return END
    }
  )
  .addEdge('review_comments_agent_node', 'review_summary_agent_node')
  .addEdge('review_summary_agent_node', END)

const checkpointer = new MemorySaver()

const graph = workflow.compile({ checkpointer })

export async function reviewPullRequest(): Promise<void> {
  await graph.invoke(
    {
      messages: []
    },
    { configurable: { thread_id: '42' } }
  )

  core.info('\n=== Final Cost Summary ===')
  core.info(`Total Input Tokens: ${costTracker.inputTokens}`)
  core.info(`Total Output Tokens: ${costTracker.outputTokens}`)
  core.info(`Total Cost: $${costTracker.totalCost.toFixed(4)}`)
}
