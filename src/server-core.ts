import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import dotenv from 'dotenv';
import { ClientFactory } from './api/client.js';
import { ConfigManager } from './config.js';
import { logger } from './logger.js';
import { NotificationManager } from './notifications/notification-manager.js';
import { 
  ParameterValidator, 
  ValidationError, 
  TOOL_NAME_MAPPINGS, 
  suggestToolName
} from './validation.js';
import { AuthenticationManager } from './auth/authentication-manager.js';
import { CoreTools } from './tools/core-tools.js';

// Load environment variables
dotenv.config();

// Tool definitions using our modular architecture
const toolDefinitions = [
  // PROJECT MANAGEMENT TOOLS
  {
    name: 'projects',
    description: 'Project management: list projects, get details, validate access, list custom fields, retrieve statistics',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'get', 'validate', 'fields', 'status'],
          description: 'Action to perform: list (all projects), get (project details), validate (check access), fields (custom fields), status (project statistics)'
        },
        projectId: {
          type: 'string',
          description: 'Project ID or shortName (required for get, validate, fields, status actions)'
        },
        fields: {
          type: 'string',
          description: 'Comma-separated fields to return (for list action)',
          default: 'id,name,shortName,description'
        }
      },
      required: ['action']
    }
  },

  // ISSUE MANAGEMENT TOOLS  
  {
    name: 'issues',
    description: 'Issue lifecycle: create, update, query/search, change state, comment, start/complete work, link issues',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['create', 'update', 'get', 'query', 'search', 'state', 'complete', 'start', 'link'],
          description: 'Action: create (new issue), update (modify), get (single issue), query (advanced search), search (smart search), state (change state), complete (mark done), start (begin work), link (relate issues)'
        },
        projectId: {
          type: 'string',
          description: 'Project ID (required for create action)'
        },
        issueId: {
          type: 'string',
          description: 'Issue ID (required for update, get, state, complete, start actions)'
        },
        summary: {
          type: 'string',
          description: 'Issue title/summary (for create/update)'
        },
        description: {
          type: 'string',
          description: 'Issue description (for create/update)'
        },
        query: {
          type: 'string',
          description: 'Search query (for query/search actions)'
        },
        state: {
          type: 'string',
          description: 'New state (for state action)'
        },
        priority: {
          type: 'string',
          description: 'Issue priority'
        },
        assignee: {
          type: 'string',
          description: 'Assignee username'
        },
        type: {
          type: 'string',
          description: 'Issue type (Bug, Feature, Task, etc.)'
        },
        comment: {
          type: 'string',
          description: 'Comment for state changes or completion'
        },
        targetIssueId: {
          type: 'string',
          description: 'Target issue to link with (required for link action)'
        },
        linkType: {
          type: 'string',
          description: 'Link command phrase (for example: "relates to", "depends on", "duplicates", "subtask of", "parent for")',
          default: 'relates to'
        }
      },
      required: ['action']
    }
  },

  // ADVANCED QUERY TOOL
  {
    name: 'query',
    description: 'Raw YouTrack query using native syntax (returns issues matching the expression)',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'YouTrack query syntax string. Examples:\n• "state: Open" - All open issues\n• "project: PROJECT-1 assignee: me" - My issues in project\n• "priority: High created: >2025-01-01" - High priority recent issues\n• "#bug -state: Resolved" - Open bugs (full-text search)'
        },
        fields: {
          type: 'string',
          description: 'Comma-separated field names to return. Example: "id,summary,state,priority" or "id,summary,description,assignee,created"',
          default: 'id,summary,description,state,priority,reporter,assignee'
        },
        limit: {
          type: 'integer',
          description: 'Maximum number of issues to return (1-1000, default: 50)',
          default: 50
        }
      },
      required: ['query']
    }
  },

    // COMMENT MANAGEMENT TOOLS
  {
    name: 'comments',
    description: 'Issue comments: list, add, update, delete',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['get', 'add', 'update', 'delete'],
          description: 'Action: get (list comments), add (new comment), update (edit), delete (remove)'
        },
        issueId: {
          type: 'string',
          description: 'Issue ID'
        },
        commentId: {
          type: 'string',
          description: 'Comment ID (required for update/delete)'
        },
        text: {
          type: 'string',
          description: 'Comment text (required for add/update)'
        }
      },
      required: ['action', 'issueId']
    }
  },

  // AGILE MANAGEMENT TOOLS
  {
    name: 'agile_boards',
    description: 'Agile boards and sprints: list boards/sprints, get details, create sprints, assign issues',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['boards', 'board_details', 'sprints', 'sprint_details', 'create_sprint', 'assign_issue'],
          description: 'Action: boards (list), board_details (get board), sprints (list), sprint_details (get sprint), create_sprint (new), assign_issue (to sprint)'
        },
        boardId: {
          type: 'string',
          description: 'Board ID (required for board_details, sprints, sprint_details, create_sprint)'
        },
        sprintId: {
          type: 'string',
          description: 'Sprint ID (required for sprint_details, assign_issue)'
        },
        issueId: {
          type: 'string',
          description: 'Issue ID (required for assign_issue)'
        },
        projectId: {
          type: 'string',
          description: 'Project ID for filtering'
        },
        name: {
          type: 'string',
          description: 'Sprint name (for create_sprint)'
        },
        start: {
          type: 'string',
          description: 'Sprint start date YYYY-MM-DD (for create_sprint)'
        },
        finish: {
          type: 'string',
          description: 'Sprint end date YYYY-MM-DD (for create_sprint)'
        }
      },
      required: ['action']
    }
  },

  // KNOWLEDGE MANAGEMENT TOOLS
  {
    name: 'knowledge_base',
    description: 'Knowledge base: list, get, create, update, delete, search articles',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'get', 'create', 'update', 'delete', 'search'],
          description: 'Action: list (all articles), get (single), create (new), update (edit), delete (remove), search (find)'
        },
        articleId: {
          type: 'string',
          description: 'Article ID (required for get, update, delete)'
        },
        title: {
          type: 'string',
          description: 'Article title (required for create, optional for update)'
        },
        content: {
          type: 'string',
          description: 'Article content (required for create, optional for update)'
        },
        summary: {
          type: 'string',
          description: 'Article summary (optional)'
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Article tags (optional)'
        },
        searchTerm: {
          type: 'string',
          description: 'Search term (required for search action)'
        },
        projectId: {
          type: 'string',
          description: 'Project ID for filtering'
        }
      },
      required: ['action']
    }
  },

  // ANALYTICS & REPORTING
  {
    name: 'analytics',
    description: 'Analytics and reporting: project statistics, time tracking, Gantt, critical path, resource allocation, milestone progress',
    inputSchema: {
      type: 'object',
      properties: {
        reportType: {
          type: 'string',
          enum: ['project_stats', 'time_tracking', 'gantt', 'critical_path', 'resource_allocation', 'milestone_progress'],
          description: 'Report type to generate'
        },
        projectId: {
          type: 'string',
          description: 'Project ID (required for most reports)'
        },
        startDate: {
          type: 'string',
          description: 'Start date YYYY-MM-DD (for time-based reports)'
        },
        endDate: {
          type: 'string',
          description: 'End date YYYY-MM-DD (for time-based reports)'
        },
        userId: {
          type: 'string',
          description: 'User ID (for user-specific reports)'
        },
        milestoneId: {
          type: 'string',
          description: 'Milestone ID (for milestone reports)'
        }
      },
      required: ['reportType']
    }
  },

  // ADMIN OPERATIONS
  {
    name: 'admin',
    description: 'Administrative operations: search users, inspect fields, list field values, bulk update, create dependencies',
    inputSchema: {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          enum: ['search_users', 'project_fields', 'field_values', 'bulk_update', 'dependencies'],
          description: 'Admin operation to perform'
        },
        query: {
          type: 'string',
          description: 'Search query (for search_users)'
        },
        projectId: {
          type: 'string',
          description: 'Project ID (for project-specific operations)'
        },
        fieldName: {
          type: 'string',
          description: 'Field name (for field_values)'
        },
        issueIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Issue IDs (for bulk operations)'
        },
        updates: {
          type: 'object',
          description: 'Update data (for bulk_update)'
        },
        sourceIssueId: {
          type: 'string',
          description: 'Source issue ID (for dependencies)'
        },
        targetIssueId: {
          type: 'string',
          description: 'Target issue ID (for dependencies)'
        }
      },
      required: ['operation']
    }
  },

  // TIME TRACKING & WORK ITEMS
  {
    name: 'time_tracking',
    description: 'Time tracking & work items: log time, manage entries and work items, generate reports',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['log_time', 'get_time_entries', 'update_time_entry', 'delete_time_entry', 'get_work_items', 'create_work_item', 'update_work_item', 'time_reports'],
          description: 'Action: log_time (add time), get_time_entries (list entries), update_time_entry (edit), delete_time_entry (remove), get_work_items (list items), create_work_item (new), update_work_item (edit), time_reports (analytics)'
        },
        issueId: {
          type: 'string',
          description: 'Issue ID (required for most time tracking operations)'
        },
        duration: {
          type: 'string',
          description: 'Time duration (e.g., "2h", "1d", "30m") for log_time'
        },
        description: {
          type: 'string',
          description: 'Work description or comment'
        },
        date: {
          type: 'string',
          description: 'Date for time entry (YYYY-MM-DD format, defaults to today)'
        },
        workItemId: {
          type: 'string',
          description: 'Work item ID (for update/delete operations)'
        },
        timeEntryId: {
          type: 'string',
          description: 'Time entry ID (for update/delete operations)'
        },
        projectId: {
          type: 'string',
          description: 'Project ID (for reports and filtering)'
        },
        userId: {
          type: 'string',
          description: 'User ID (for reports and filtering)'
        },
        startDate: {
          type: 'string',
          description: 'Start date for reports (YYYY-MM-DD)'
        },
        endDate: {
          type: 'string',
          description: 'End date for reports (YYYY-MM-DD)'
        },
        workType: {
          type: 'string',
          description: 'Type of work (Development, Testing, Documentation, etc.)'
        }
      },
      required: ['action']
    }
  },

  // AUTHENTICATION MANAGEMENT
  {
    name: 'auth',
    description: 'Authentication: status, OAuth2 login, logout, re-authenticate, validate token',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['status', 'login', 'logout', 'reauth', 'test'],
          description: 'Action: status (check auth), login (OAuth2 browser), logout (sign out), reauth (force re-auth), test (validate token)'
        }
      },
      required: ['action']
    }
  },

  // REAL-TIME NOTIFICATIONS
  {
    name: 'notifications',
    description: 'Notifications: status, list, clear, subscribe/unsubscribe, list subscriptions',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['status', 'list', 'clear', 'subscribe', 'unsubscribe', 'subscriptions'],
          description: 'Action: status (connection status), list (recent notifications), clear (clear all), subscribe (create subscription), unsubscribe (remove subscription), subscriptions (list subscriptions)'
        },
        limit: {
          type: 'number',
          description: 'Maximum number of notifications to return (for list action)',
          default: 50
        },
        id: {
          type: 'string',
          description: 'Subscription ID (for unsubscribe action)'
        },
        name: {
          type: 'string',
          description: 'Subscription name (for subscribe action)'
        },
        filters: {
          type: 'object',
          description: 'Notification filters (for subscribe action)'
        },
        enabled: {
          type: 'boolean',
          description: 'Whether subscription is enabled (for subscribe action)',
          default: true
        },
        deliveryMethods: {
          type: 'array',
          items: { type: 'string' },
          description: 'Delivery methods for notifications (for subscribe action)',
          default: ['immediate']
        }
      },
      required: ['action']
    }
  },

  // NOTIFICATION SUBSCRIPTIONS
  {
    name: 'subscriptions',
    description: 'Notification subscriptions: create, update, delete, list',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['create', 'update', 'delete', 'list'],
          description: 'Action: create (new subscription), update (modify existing), delete (remove), list (all subscriptions)'
        },
        id: {
          type: 'string',
          description: 'Subscription ID (required for update/delete actions)'
        },
        name: {
          type: 'string',
          description: 'Subscription name (required for create action)'
        },
        filters: {
          type: 'object',
          description: 'Notification filters (project, issue type, priority, etc.)'
        },
        enabled: {
          type: 'boolean',
          description: 'Whether subscription is enabled',
          default: true
        },
        deliveryMethods: {
          type: 'array',
          items: { type: 'string' },
          description: 'How notifications should be delivered',
          default: ['immediate']
        },
        updates: {
          type: 'object',
          description: 'Updates to apply to subscription (for update action)'
        }
      },
      required: ['action']
    }
  }
];

export class YouTrackMCPServer {
  private server: Server;
  private clientFactory: ClientFactory;
  private config: ConfigManager;
  private authManager: AuthenticationManager;
  private coreTools: CoreTools;
  private transport: Transport | null = null;
  private notificationManager: NotificationManager | null = null;
  private notificationsInitialized = false;

  constructor() {
    this.config = new ConfigManager();
    this.config.validate();

    const { youtrackUrl, youtrackToken } = this.config.get();
    
    // Initialize authentication manager
    this.authManager = new AuthenticationManager({
      baseUrl: youtrackUrl,
      token: youtrackToken,
      preferOAuth2: false, // Default to token-based auth
      autoRefresh: true
    });
    
  // Initialize core tools with authentication manager
  this.coreTools = new CoreTools(this.authManager);
  logger.info('Initializing YouTrack MCP Server', { 
      url: youtrackUrl, 
      tokenLength: youtrackToken?.length,
      toolCount: toolDefinitions.length 
    });
    
    // Initialize client factory
    this.clientFactory = new ClientFactory({
      baseURL: youtrackUrl,
      token: youtrackToken,
      timeout: 30000,
      retryAttempts: 3,
      retryDelay: 1000,
      enableCache: true
    });

  logger.info('Client Factory initialized');

    this.server = new Server(
      {
        name: 'youtrack-mcp',
        version: '2.0.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupToolHandlers();
  }

  private resolveProjectId(providedProjectId?: string): string {
    const config = this.config.get();
    const projectId = providedProjectId || config.defaultProjectId;
    
    if (!projectId) {
      throw new Error('Project ID is required. Either provide projectId parameter or set PROJECT_ID environment variable.');
    }
    
    return projectId;
  }

  private setupToolHandlers(): void {
    // Register tool definitions
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: toolDefinitions,
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args = {} } = request.params;

      try {
        const client = this.clientFactory.createClient();
        
        switch (name) {
          case 'projects':
            return await this.handleProjectsManage(client, args);
          
          case 'issues':
            return await this.handleIssuesManage(client, args);
          
          case 'query':
            return await this.handleQueryIssues(client, args);
          
          case 'comments':
            return await this.handleCommentsManage(client, args);
          
          case 'agile_boards':
            return await this.handleAgileManage(client, args);
          
          case 'knowledge_base':
            return await this.handleKnowledgeManage(client, args);
          
          case 'analytics':
            return await this.handleAnalyticsReport(client, args);
          
          case 'admin':
            return await this.handleAdminOperations(client, args);
          
          case 'time_tracking':
            return await this.handleTimeTracking(client, args);
          
          case 'auth':
            return await this.coreTools.handleAuthManage(args);
          
          case 'notifications':
            return await this.coreTools.handleNotifications(args);
          
          case 'subscriptions':
            return await this.coreTools.handleSubscriptions(args);
          
          default: {
            const suggestion = suggestToolName(name);
            logger.warn('Unknown tool requested', { 
              tool: name, 
              suggestion: TOOL_NAME_MAPPINGS[name] || 'none',
              availableTools: ['projects', 'issues', 'query', 'comments', 'agile_boards', 'knowledge_base', 'analytics', 'admin', 'time_tracking', 'auth', 'notifications', 'subscriptions']
            });
            throw new McpError(
              ErrorCode.MethodNotFound,
              `Unknown tool: ${name}. ${suggestion}`
            );
          }
        }
      } catch (error) {
        logger.error('Tool execution error', { tool: name, error: error instanceof Error ? error.message : error });
        
        if (error instanceof McpError) {
          throw error;
        }
        
        throw new McpError(
          ErrorCode.InternalError,
          `Tool execution failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    });
  }

  private async handleProjectsManage(client: any, args: any) {
    const { action, projectId, fields } = args;
    
    // Validate project ID for actions that require it
    const needsProjectId = ['get', 'validate', 'fields', 'status'];
    if (needsProjectId.includes(action)) {
      try {
        ParameterValidator.validateProjectId(projectId || this.resolveProjectId(), 'projectId');
      } catch (error) {
        logger.error('Project validation failed', { 
          action, 
          projectId: projectId || this.resolveProjectId(), 
          error: error instanceof Error ? error.message : error 
        });
        throw new McpError(
          ErrorCode.InvalidParams,
          `Invalid project ID for ${action} action: ${error instanceof Error ? error.message : error}`
        );
      }
    }
    
    switch (action) {
      case 'list':
        return await client.projects.listProjects(fields);
      case 'get':
        return await client.projects.getProject(projectId || this.resolveProjectId());
      case 'validate':
        return await client.projects.validateProject(projectId || this.resolveProjectId());
      case 'fields':
        return await client.projects.getProjectCustomFields(projectId || this.resolveProjectId());
      case 'status':
        return await client.projects.getProjectStatistics(projectId || this.resolveProjectId());
      default:
        throw new Error(`Unknown projects action: ${action}`);
    }
  }

  private async handleIssuesManage(client: any, args: any) {
    const { action, projectId, issueId, summary, description, query, state, comment, priority, assignee, type, targetIssueId, linkType } = args;
    let normalizedLinkType = linkType;
    
    // Validate parameters based on action
    try {
      switch (action) {
        case 'create':
          ParameterValidator.validateProjectId(projectId || this.resolveProjectId(), 'projectId');
          ParameterValidator.validateRequired(summary, 'summary');
          break;
        case 'update':
        case 'get':
        case 'state':
        case 'complete':
        case 'start':
          ParameterValidator.validateIssueId(issueId, 'issueId');
          break;
        case 'link':
          ParameterValidator.validateIssueId(issueId, 'issueId');
          ParameterValidator.validateIssueId(targetIssueId, 'targetIssueId');
          if (linkType !== undefined) {
            normalizedLinkType = ParameterValidator.validateRequired(linkType, 'linkType');
          }
          break;
        case 'query':
        case 'search':
          ParameterValidator.validateRequired(query, 'query');
          break;
      }
    } catch (error) {
      logger.error('Issue parameter validation failed', { 
        action, 
        projectId, 
        issueId, 
        error: error instanceof Error ? error.message : error 
      });
      if (error instanceof ValidationError) {
        throw ParameterValidator.toMcpError(error);
      }
      throw error;
    }
    
    switch (action) {
      case 'create':
        return await client.issues.createIssue(projectId || this.resolveProjectId(), { 
          summary, description, priority, assignee, type 
        });
      case 'update':
        return await client.issues.updateIssue(issueId, { 
          summary, description, state, priority, assignee, type 
        });
      case 'get':
        return await client.issues.getIssue(issueId);
      case 'query':
        return await client.issues.queryIssues({ query });
      case 'search':
        return await client.issues.smartSearchIssues(query, { projectId });
      case 'state':
        return await client.issues.changeIssueState(issueId, state, comment);
      case 'complete':
        return await client.issues.completeIssue(issueId, comment);
      case 'start':
        return await client.issues.startWorkingOnIssue(issueId, comment);
      case 'link':
        return await client.issues.linkIssues(issueId, targetIssueId, normalizedLinkType);
      default:
        throw new Error(`Unknown issues action: ${action}`);
    }
  }

  private async handleQueryIssues(client: any, args: any) {
    const { query, fields, limit } = args;
    return await client.issues.queryIssues({ 
      query, 
      fields: fields ? fields.split(',') : ['id', 'summary', 'description', 'state', 'priority', 'reporter', 'assignee'],
      limit: limit || 50
    });
  }

  private async handleCommentsManage(client: any, args: any) {
    const { action, issueId, commentId, text } = args;
    
    // Validate parameters
    try {
      ParameterValidator.validateIssueId(issueId, 'issueId');
      
      if (['add', 'update'].includes(action)) {
        ParameterValidator.validateRequired(text, 'text');
      }
      
      if (['update', 'delete'].includes(action)) {
        ParameterValidator.validateRequired(commentId, 'commentId');
      }
    } catch (error) {
      logger.error('Comment parameter validation failed', { 
        action, 
        issueId, 
        commentId, 
        error: error instanceof Error ? error.message : error 
      });
      if (error instanceof ValidationError) {
        throw ParameterValidator.toMcpError(error);
      }
      throw error;
    }
    
    switch (action) {
      case 'get':
        return await client.issues.getIssueComments(issueId);
      case 'add':
        return await client.issues.addComment(issueId, text);
      case 'update':
        return await client.issues.updateComment(issueId, commentId, text);
      case 'delete':
        return await client.issues.deleteComment(issueId, commentId);
      default:
        throw new Error(`Unknown comments action: ${action}`);
    }
  }

  private async handleAgileManage(client: any, args: any) {
    const { action, boardId, sprintId, issueId, projectId, name, start, finish } = args;
    
    switch (action) {
      case 'boards':
        return await client.agile.listAgileBoards({ projectId });
      case 'board_details':
        return await client.agile.getBoardDetails(boardId, true, true);
      case 'sprints':
        return await client.agile.listSprints(boardId, false, false);
      case 'sprint_details':
        return await client.agile.getSprintDetails(boardId, sprintId, true);
      case 'create_sprint':
        return await client.agile.createSprint(boardId, name, start, finish);
      case 'assign_issue':
        return await client.agile.assignIssueToSprint(issueId, sprintId, boardId);
      default:
        throw new Error(`Unknown agile action: ${action}`);
    }
  }

  private async handleKnowledgeManage(client: any, args: any) {
    const { action, articleId, title, content, summary, tags, searchTerm, projectId } = args;
    
    switch (action) {
      case 'list':
        return await client.knowledgeBase.listArticles(false, projectId);
      case 'get':
        return await client.knowledgeBase.getArticle(articleId, false);
      case 'create':
        return await client.knowledgeBase.createArticle({ title, content, summary, tags, projectId });
      case 'update':
        return await client.knowledgeBase.updateArticle(articleId, { title, content, summary, tags });
      case 'delete':
        return await client.knowledgeBase.deleteArticle(articleId);
      case 'search':
        return await client.knowledgeBase.searchArticles(searchTerm, false, projectId, tags);
      default:
        throw new Error(`Unknown knowledge action: ${action}`);
    }
  }

  private async handleAnalyticsReport(client: any, args: any) {
    const { reportType, projectId, startDate, endDate, userId, milestoneId } = args;
    
    // Validate project ID for project-specific reports
    const needsProjectId = ['project_stats', 'gantt', 'critical_path', 'resource_allocation'];
    if (needsProjectId.includes(reportType)) {
      try {
        const validatedProjectId = ParameterValidator.validateProjectId(projectId || this.resolveProjectId(), 'projectId');
        // Verify project exists before using it
        await client.projects.validateProject(validatedProjectId);
      } catch (error) {
        logger.error('Analytics project validation failed', { 
          reportType, 
          projectId: projectId || this.resolveProjectId(), 
          error: error instanceof Error ? error.message : error 
        });
        throw new McpError(
          ErrorCode.InvalidParams,
          `Invalid project ID for ${reportType} report: ${error instanceof Error ? error.message : error}`
        );
      }
    }

    // Validate date formats
    if (startDate) {
      ParameterValidator.validateDate(startDate, 'startDate');
    }
    if (endDate) {
      ParameterValidator.validateDate(endDate, 'endDate');
    }
    
    switch (reportType) {
      case 'project_stats':
        return await client.projects.getProjectStatistics(projectId || this.resolveProjectId(), startDate, endDate, true);
      case 'time_tracking':
        return await client.admin.getTimeTrackingReport(startDate, endDate, 'user', projectId, userId);
      case 'gantt':
        return await client.admin.generateGanttChart(projectId || this.resolveProjectId(), startDate, endDate);
      case 'critical_path':
        return await client.admin.getCriticalPath(projectId || this.resolveProjectId());
      case 'resource_allocation':
        return await client.admin.getResourceAllocation(projectId || this.resolveProjectId(), startDate, endDate);
      case 'milestone_progress':
        return await client.admin.getMilestoneProgress(milestoneId);
      default:
        throw new Error(`Unknown report type: ${reportType}`);
    }
  }

  private async handleAdminOperations(client: any, args: any) {
    const { operation, query, projectId, fieldName, issueIds, updates, sourceIssueId, targetIssueId } = args;
    
    switch (operation) {
      case 'search_users':
        return await client.admin.searchUsers(query);
      case 'project_fields':
        return await client.projects.getProjectCustomFields(projectId || this.resolveProjectId());
      case 'field_values':
        return await client.projects.getProjectFieldValues(projectId || this.resolveProjectId(), fieldName);
      case 'bulk_update':
        return await client.admin.bulkUpdateIssues(issueIds, updates);
      case 'dependencies':
        return await client.admin.createIssueDependency(sourceIssueId, targetIssueId);
      default:
        throw new Error(`Unknown admin operation: ${operation}`);
    }
  }

  private async handleTimeTracking(client: any, args: any) {
    const { action, issueId, duration, description, date, workItemId, timeEntryId, projectId, userId, startDate, endDate, workType } = args;
    
    // Validate parameters based on action
    try {
      const needsIssueId = ['log_time', 'get_time_entries', 'get_work_items', 'create_work_item'];
      if (needsIssueId.includes(action)) {
        ParameterValidator.validateIssueId(issueId, 'issueId');
      }
      
      if (action === 'log_time') {
        ParameterValidator.validateDuration(duration, 'duration');
      }
      
      // Validate date formats
      if (date) ParameterValidator.validateDate(date, 'date');
      if (startDate) ParameterValidator.validateDate(startDate, 'startDate');
      if (endDate) ParameterValidator.validateDate(endDate, 'endDate');
      
      // Validate required IDs for specific actions
      if (['update_time_entry', 'delete_time_entry'].includes(action)) {
        ParameterValidator.validateRequired(timeEntryId, 'timeEntryId');
      }
      if (action === 'update_work_item') {
        ParameterValidator.validateRequired(workItemId, 'workItemId');
      }
    } catch (error) {
      logger.error('Time tracking parameter validation failed', { 
        action, 
        issueId, 
        duration, 
        error: error instanceof Error ? error.message : error 
      });
      if (error instanceof ValidationError) {
        throw ParameterValidator.toMcpError(error);
      }
      throw error;
    }
    
    switch (action) {
      case 'log_time':
        return await client.workItems.logTimeToIssue(issueId, duration, description, date, workType);
      case 'get_time_entries':
        return await client.workItems.getTimeEntries(issueId, startDate, endDate, userId);
      case 'update_time_entry':
        return await client.workItems.updateTimeEntry(timeEntryId, { duration, description, date, workType });
      case 'delete_time_entry':
        return await client.workItems.deleteTimeEntry(timeEntryId);
      case 'get_work_items':
        return await client.workItems.getWorkItems(issueId, projectId, userId);
      case 'create_work_item':
        return await client.workItems.createWorkItem({ issueId, description, workType, duration, date });
      case 'update_work_item':
        return await client.workItems.updateWorkItem(workItemId, { description, workType, duration, date });
      case 'time_reports':
        return await client.workItems.generateTimeReport(projectId, startDate, endDate, userId);
      default:
        throw new Error(`Unknown time tracking action: ${action}`);
    }
  }

  public onConnectionClose(handler: () => void | Promise<void>): void {
    this.server.onclose = () => {
      Promise.resolve(handler()).catch((error) => {
        logger.error('Error while handling MCP connection close', error);
      });
    };
  }

  public onConnectionError(handler: (error: Error) => void | Promise<void>): void {
    this.server.onerror = (error: Error) => {
      Promise.resolve(handler(error)).catch((handlerError) => {
        logger.error('Error while handling MCP connection error', handlerError);
      });
    };
  }

  private async initializeNotifications(): Promise<void> {
    if (this.notificationsInitialized) {
      return;
    }

    try {
      const notificationManager = new NotificationManager(
        this.config.get().youtrackUrl || ''
      );
      await notificationManager.initialize(await this.authManager.getAuthToken());
      this.notificationManager = notificationManager;
      this.notificationsInitialized = true;
      logger.info('Notification system initialized (polling mode)');
    } catch (error) {
      logger.warn(
        'Failed to initialize notification system, continuing without real-time notifications',
        error
      );
    }
  }

  async connect(transport: Transport): Promise<void> {
    this.transport = transport;
    await this.server.connect(transport);
    await this.initializeNotifications();
    logger.info('YouTrack MCP Server connected', {
      transport: transport.constructor?.name ?? 'UnknownTransport',
      toolCount: toolDefinitions.length,
    });
  }

  async run(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.connect(transport);
    logger.info('YouTrack MCP Server running with stdio transport');
  }

  /**
   * Cleanup resources on shutdown
   */
  async cleanup(options: { disconnect?: boolean } = {}): Promise<void> {
    if (options.disconnect && this.transport) {
      try {
        await this.transport.close();
      } catch (error) {
        logger.warn('Error while closing MCP transport during cleanup', error);
      }
    }

    this.transport = null;

    if (this.notificationManager) {
      this.notificationManager.removeAllListeners();
      this.notificationManager = null;
    }
    this.notificationsInitialized = false;

    this.coreTools.cleanup();
    logger.info('Server resources cleaned up');
  }
}
