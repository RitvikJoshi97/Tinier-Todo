export namespace main {
	
	export class Column {
	    id: string;
	    name: string;
	    done?: boolean;
	
	    static createFrom(source: any = {}) {
	        return new Column(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.name = source["name"];
	        this.done = source["done"];
	    }
	}
	export class Board {
	    id: string;
	    name: string;
	    createdAt: string;
	    columns: Column[];
	
	    static createFrom(source: any = {}) {
	        return new Board(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.name = source["name"];
	        this.createdAt = source["createdAt"];
	        this.columns = this.convertValues(source["columns"], Column);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class BoardsState {
	    boards: Board[];
	    activeBoardId: string;
	
	    static createFrom(source: any = {}) {
	        return new BoardsState(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.boards = this.convertValues(source["boards"], Board);
	        this.activeBoardId = source["activeBoardId"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	
	export class Comment {
	    id: number;
	    text: string;
	    timestamp: string;
	    editedAt?: string;
	
	    static createFrom(source: any = {}) {
	        return new Comment(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.text = source["text"];
	        this.timestamp = source["timestamp"];
	        this.editedAt = source["editedAt"];
	    }
	}
	export class DiskEncryptionStatus {
	    state: string;
	    name: string;
	
	    static createFrom(source: any = {}) {
	        return new DiskEncryptionStatus(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.state = source["state"];
	        this.name = source["name"];
	    }
	}
	export class Draft {
	    fields: Record<string, string>;
	    updatedAt: string;
	
	    static createFrom(source: any = {}) {
	        return new Draft(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.fields = source["fields"];
	        this.updatedAt = source["updatedAt"];
	    }
	}
	export class ReminderSettings {
	    enabled: boolean;
	    hour: number;
	
	    static createFrom(source: any = {}) {
	        return new ReminderSettings(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.enabled = source["enabled"];
	        this.hour = source["hour"];
	    }
	}
	export class Settings {
	    reminders: ReminderSettings;
	
	    static createFrom(source: any = {}) {
	        return new Settings(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.reminders = this.convertValues(source["reminders"], ReminderSettings);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class Ticket {
	    id: number;
	    name: string;
	    description: string;
	    project: string;
	    link: string;
	    deadline: string;
	    status: string;
	    comments: Comment[];
	    deletedAt?: string;
	
	    static createFrom(source: any = {}) {
	        return new Ticket(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.name = source["name"];
	        this.description = source["description"];
	        this.project = source["project"];
	        this.link = source["link"];
	        this.deadline = source["deadline"];
	        this.status = source["status"];
	        this.comments = this.convertValues(source["comments"], Comment);
	        this.deletedAt = source["deletedAt"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class TicketFields {
	    name: string;
	    description: string;
	    project: string;
	    link: string;
	    deadline: string;
	    status: string;
	
	    static createFrom(source: any = {}) {
	        return new TicketFields(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.description = source["description"];
	        this.project = source["project"];
	        this.link = source["link"];
	        this.deadline = source["deadline"];
	        this.status = source["status"];
	    }
	}

}

