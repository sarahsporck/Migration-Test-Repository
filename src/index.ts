import { configDotenv } from "dotenv"

configDotenv({ path: '.env.local' })
import j2m from 'jira2md'
import jiraClient, { getBoardIdByName } from "./jira"
import octokitClient from "./octokit"

const jira = jiraClient()
const octokit = octokitClient()

const nameMapping = {
    'Steffanie Metzger': 'SteffiStuffel',
    'Sarah Sporck': 'sarahsporck',
    'Steffen Kleinle': 'steffenkleinle',
    'Leandra Hahn': 'LeandraH',
    'Andreas Fischer': 'f1sh1918',
    'Aizhan Alekbarova': 'lunars97'
}

const validKeys = process.env.PROJECTS!.split(',')

const migrateEpics = async (jiraBoardId: string): Promise<Record<number, number>> => {
    const doneEpics = await jira.getEpics(jiraBoardId, 0, 100, "true")
    const openEpics = await jira.getEpics(jiraBoardId, 0, 100, "false")
    const allDoneAndOpenEpics = [...openEpics.values, ...doneEpics.values]
    const allEpics = allDoneAndOpenEpics.filter((epic: any) => validKeys.includes(epic.key.split('-')[0]))

    const listedMilestones = await octokit.rest.issues.listMilestones({
        owner: process.env.GITHUB_OWNER!,
        repo: process.env.GITHUB_REPO!,
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
            owner: process.env.GITHUB_OWNER!,
            repo: process.env.GITHUB_REPO!,
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

const migrateIssues = async (jiraBoardId: string, epicMap: Record<number, number>) => {
    const maxResults = 50
    const jql = `project IN(${process.env.PROJECTS})`
    let startAt = 0
    let hasNext = true
    while (hasNext) {
        const result = await jira.getIssuesForBoard(jiraBoardId, startAt, maxResults, jql, true)
        await Promise.all(result.issues.map(async (issue: any, index: number) => {
            if (issue.fields.issuetype.name === "Epic") { return }
            if (index > 10) { return }
            const createdIssue = await octokit.rest.issues.create({
                owner: process.env.GITHUB_OWNER!,
                repo: process.env.GITHUB_REPO!,
                title: issue.key + ': ' + issue.fields.summary,
                body: buildIssueBody(issue),
                milestone: issue.fields.epic ? epicMap[issue.fields.epic.id] : undefined,
                labels: getLabelsForIssue(issue),
                // assignees: nameMapping[issue.fields.assignee.displayName] ?? undefined
            })

            if (issue.fields.comment && issue.fields.comment.total > 0) {
                await Promise.all(issue.fields.comment.comments.map(async (comment) => {
                    await octokit.rest.issues.createComment({
                        owner: process.env.GITHUB_OWNER!,
                        repo: process.env.GITHUB_REPO!,
                        issue_number: createdIssue.data.number,
                        body: `
**${nameMapping[comment.author.displayName] ?? comment.author.displayName} - ${new Date(comment.created).toLocaleString('de')}**

${j2m.to_markdown(comment.body)}
`
                    })
                }))

            }

            if (issue.fields.status.statusCategory.name === "Done") {
                await octokit.rest.issues.update({
                    owner: process.env.GITHUB_OWNER!,
                    repo: process.env.GITHUB_REPO!,
                    issue_number: createdIssue.data.number,
                    state: issue.fields.status.statusCategory.name !== "Done" ? "open" : "closed"
                })
            }
        }))

        startAt = result.startAt + result.maxResults
        hasNext = startAt < result.issues.total
    };
}

const run = async () => {
    const jiraBoardId = await getBoardIdByName(jira, "App-Team")

    const epicMap = await migrateEpics(jiraBoardId)
    await migrateIssues(jiraBoardId, epicMap)
}

run()