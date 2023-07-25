import { Octokit } from "@octokit/rest"
import { SingleBar } from "cli-progress"
import { program } from "commander"
import { configDotenv } from "dotenv"
import JiraApi from "jira-client"

configDotenv({ path: '.env.local' })
import j2m from 'jira2md'
import jiraClient, { getBoardIdByName } from "./jira"
import octokitClient from "./octokit"

const owner = process.env.GITHUB_OWNER!
const repo = process.env.GITHUB_REPO!

const nameMapping = {
    //    'Steffanie Metzger': 'SteffiStuffel',
    'Sarah Sporck': 'sarahsporck',
    //    'Steffen Kleinle': 'steffenkleinle',
    //    'Leandra Hahn': 'LeandraH',
    //    'Andreas Fischer': 'f1sh1918',
    //    'Aizhan Alekbarova': 'lunars97'
}

const validKeys = process.env.PROJECTS!.split(',')

const migrateEpics = async (jira: JiraApi, octokit: Octokit, jiraBoardId: string): Promise<Record<number, number>> => {
    const doneEpics = await jira.getEpics(jiraBoardId, 0, 100, "true")
    const openEpics = await jira.getEpics(jiraBoardId, 0, 100, "false")
    const allDoneAndOpenEpics = [...openEpics.values, ...doneEpics.values]
    const allEpics = allDoneAndOpenEpics.filter((epic: any) => validKeys.includes(epic.key.split('-')[0]))

    const listedMilestones = await octokit.rest.issues.listMilestones({
        owner,
        repo,
        state: 'all',
    })

    const githubEpicMap = {}
    if (listedMilestones.data.length > 0) {
        // assume milestones have already been created
        const epicMapping = listedMilestones.data.map((milestone) => {
            const epic = allEpics.find(epic => epic.name === milestone.title)
            return [epic.id, milestone.number]
        })
        Object.assign(githubEpicMap, Object.fromEntries(epicMapping))
    }

    const epics = allEpics.filter((epic: any) => !(epic.id in githubEpicMap))
    console.log(epics)
    const epicMapping = await Promise.all(epics.map(async (epic) => {
        const issueForEpic = await jira.getIssue(epic.key, ['description'])

        const result = await octokit.rest.issues.createMilestone({
            owner,
            repo,
            title: epic.name,
            state: epic.done ? 'closed' : 'open',
            description: issueForEpic.fields.description ?? epic.summary
        })

        return [epic.id, result.data.number]
    }
    ))
    return { ...githubEpicMap, ...Object.fromEntries(epicMapping) }
}

const buildIssueBody = (issue: any) => {
    const body = j2m.to_markdown(issue.fields.description)
    const creator = nameMapping[issue.fields.creator.displayName] ?? issue.fields.creator.displayName
    const createdAt = new Date(issue.fields.created)
    const linkedIssues = issue.fields.issuelinks.map((link: any) => {
        const relatedIssue = link.inwardIssue ?? link.outwardIssue ?? {}
        return `- ${link.type.name}: ${relatedIssue.key}`
    }).join('\n')
    const environment = issue.fields.customfield_10604
    return `
# ${creator} - ${createdAt.toLocaleString('de')}

${body}

**Environment**: ${environment ?? '-'}
**Linked issues:**
${linkedIssues ?? '-'}
`
}

const getLabelsForIssue = (issue: any) => {
    const actualLabels = issue.fields.labels ? issue.fields.labels : {}
    const componentLabels = issue.fields.components ? issue.fields.components.map(comp => comp.name) : {}
    return [...actualLabels, ...componentLabels, issue.fields.issuetype.name]
}

const waitForSeconds = async (seconds: number) => {
    await new Promise(resolve => setTimeout(resolve, seconds * 1000));
}

const createComments = async (octokit: Octokit, issue, comments) => (await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: issue.data.number,
    body: comments.map(comment => `
**${nameMapping[comment.author.displayName] ?? comment.author.displayName} - ${new Date(comment.created).toLocaleString('de')}**

${j2m.to_markdown(comment.body)}

`).join('\n')
}))

const migrateIssues = async (jira: JiraApi, octokit: Octokit, jiraBoardId: string, epicMap: Record<number, number>, startAt: number) => {
    const maxResults = 50
    let currentStartAt = startAt
    const jql = `project IN (${process.env.PROJECTS}) ORDER BY createdDate ASC`
    let result = await jira.getIssuesForBoard(jiraBoardId, startAt, 1, jql, true)
    const issueMigrateProgress = new SingleBar({ })
    issueMigrateProgress.start(result.total, startAt)
    let hasNext = true
    while (hasNext) {
        result = await jira.getIssuesForBoard(jiraBoardId, startAt, maxResults, jql, true)
        for (let index = 0; index < result.issues.length; index += 1) {
            const issue = result.issues[index]
            issueMigrateProgress.update(currentStartAt + index)
            if (issue.fields.issuetype.name === "Epic") { continue }
            const assignee = issue.fields.assignee && nameMapping[issue.fields.assignee.displayName] ? nameMapping[issue.fields.assignee.displayName] : undefined
            const createdIssue = await octokit.rest.issues.create({
                owner,
                repo,
                title: issue.key + ': ' + issue.fields.summary,
                body: buildIssueBody(issue),
                milestone: issue.fields.epic ? epicMap[issue.fields.epic.id] : undefined,
                labels: getLabelsForIssue(issue),
                assignees: assignee ? [assignee] : undefined
            })

            if (issue.fields.comment && issue.fields.comment.total > 0) {
                await createComments(octokit, createdIssue, issue.fields.comment.comments)
            }

            if (issue.fields.status.statusCategory.name === "Done") {
                await octokit.rest.issues.update({
                    owner,
                    repo,
                    issue_number: createdIssue.data.number,
                    state: issue.fields.status.statusCategory.name !== "Done" ? "open" : "closed"
                })
            }
            await waitForSeconds(8)
        }

        currentStartAt += result.maxResults
        hasNext = currentStartAt < result.total
    };
}


program.command('migrate').option('--start-at <startAt>', undefined, '0')
    .action(async ({ startAt }: { startAt: string }) => {
        const parsedStartAt = parseInt(startAt)

        const jira = jiraClient()
        const octokit = await octokitClient(process.env.GITHUB_PRIVATE_KEY!, owner, repo)
        const jiraBoardId = await getBoardIdByName(jira, "App-Team")

        const epicMap = await migrateEpics(jira, octokit, jiraBoardId)
        await migrateIssues(jira, octokit, jiraBoardId, epicMap, parsedStartAt)
    })

program.parse(process.argv)