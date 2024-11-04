const socketIo=require("socket.io");
const fetch=require("node-fetch");
const fs=require("fs");
const {
	encodeBase64,
	decodeBase64,
	jsonParseTry,
}=globals.functions;

const services={
	account: service_require("server/account/account.new"),
};

const tmpSAV=(data)=>{
	fs.writeFileSync("/tmp/tmpSave.json",JSON.stringify(data,null,"\t"));
}

const configFile="data/spotifyLoginData.json";
const URLS={
	"authorize":	"https://accounts.spotify.com/authorize",
	"devices":		"https://api.spotify.com/v1/me/player/devices",
	"my-tracks":	"https://api.spotify.com/v1/me/tracks", //my collection (lieblingssongs)
	"next":			"https://api.spotify.com/v1/me/player/next",
	"nowPlaying": 	"https://api.spotify.com/v1/me/player/currently-playing",
	"pause": 		"https://api.spotify.com/v1/me/player/pause",
	"play":			"https://api.spotify.com/v1/me/player/play",
	"player":		"https://api.spotify.com/v1/me/player",
	"playlist":		"https://api.spotify.com/v1/playlists",
	"playlists": 	"https://api.spotify.com/v1/me/playlists",
	"position":		"https://api.spotify.com/v1/me/player/seek",
	"previous":		"https://api.spotify.com/v1/me/player/previous",
	"shuffle":		"https://api.spotify.com/v1/me/player/shuffle",
	"token":		"https://accounts.spotify.com/api/token",
	"tracks":		"https://api.spotify.com/v1/playlists/[playListId]/tracks",
	"volume":		"https://api.spotify.com/v1/me/player/volume",
};
const TEMPLATES={
	track:{
		id: null,
		imgs: null,
		length: null,
		mp3: null,
		name: null,
		url: null,
	},
	playlist:{
		description: null,
		id: null,
		imgs: null,
		items: null,
		name: null,
		ownerId: null,
		ownerName: null,
		ownerUrl: null,
		public: null,
		total: null,
		url: null,
	},
	device:{
		active: null,
		id: null,
		name: null,
		type: null,
		volume: null,
		volumeSupport: null,
	},
}

this.start=()=>{
	this.clients=new Map();
	this.config=this.readConf();
	this.infos_raw=null;
	this.infos=null;
	this.playlists=new Map();
	this.tracks=new Map();
	this.info_last={
		deviceId: null,
		lastSend: 0,
		playing: null,
		progress: 0,
		sourceId: null,
		trackId: null,
		volume: null,
		noPlayback: null,
	};

	this.io=new socketIo.Server(13756,{cors:{origin:"*"}});
	this.io.on("connection",socket=>{
		const id=socket.id;
		let client={
			account: null,
			allowChangePlayback: false,
			socket,
			token: null,
		};
		this.clients.set(id,client);
		auth:{
			const auth=socket.handshake.auth;
			if(typeof(auth)!=="object") break auth;
			if(!auth.token) break auth;
			const login=services.account.authUserByInput({
				token: auth.token,
			});
			if(!login.allowed) break auth;
			const account=login.data.account;
			client=this.writeClient(id,{
				account,
				token: auth.token,
			});
			const allowChangePlayback=services.account.hasAccountRankAttr({
				rankAttr: "spotifyApi-changePlayback",
				username: account.username,
			});
			client=this.writeClient(id,{
				allowChangePlayback,
			});
		}
		socket.emit("init",{
			account: !client.account?null:{
				username: client.account.username,
				nickname: client.account.nickname,
			},
			allowChangePlayback: client.allowChangePlayback,
			currentlyPlaying: this.infos,
		});
		socket.on("get-infos",(returnType="emit",cb)=>{
			if(returnType==="emit"){
				socket.emit("set-infos",this.infos);
				if(cb) cb(false);
			}
			else if(returnType==="callback"){
				cb(this.infos);
			}
		});
		socket.on("get-track",trackId=>{
			if(!this.tracks.has(trackId)){
				socket.emit("error","get-track","trackId dont exists!");
				return;
			}
			socket.emit("set-track",trackId,this.tracks.get(trackId));
		});
		socket.on("get-playlist",playlistId=>{
			if(!this.playlists.has(playlistId)){
				socket.emit("error","get-playlists","playlistId dont exists!");
				return;
			}
			socket.emit("set-playlist",playlistId,this.playlists.get(playlistId));
		});
		socket.on("disconnect",()=>{
			this.clients.delete(id);
		});

		if(client.allowChangePlayback){
			socket.on("playbackAction",this.playbackAction);
			socket.on("set-volume",volume=>{
				this.callApi({
					method: "put",
					url: URLS.volume+"?device_id"+this.info_last.deviceId+"&volume_percent="+Number(volume),
				});
			});
			socket.on("set-position",position=>{
				this.callApi({
					method: "put",
					url: URLS.position+"?device_id"+this.info_last.deviceId+"&position_ms="+Number(position),
				});
			});
		}
	});

	if(this.config.access_token){
		this.callApi({
			method: "get",
			url: URLS.player,
			request: "get track",
		});
	}else if(this.config.refresh_token&&this.config.refresh_token){
		this.refresh_access_token();
	}
	setInterval(()=>{ // IRGENDWIE TROZDEM ALLE 500ms WENN CLIENT VERBUNDEN DUMM!!! ABER WENN NICHT VERBUNDEN GEHT!
		const now=Date.now();
		const call=()=>{
			this.callApi({
				method: "get",
				request: "get track",
				url: URLS.player,
			});
			this.info_last.lastSend=now;
		}

		if(
			now-this.info_last.lastSend>3e3&&
			this.clients.size>0
		) call();
		else if(
			now-this.info_last.lastSend>10e3&&
			this.clients.size===0
		) call();

	},5e3);
}
this.writeClient=(id,object)=>{
	const client={
		...this.clients.get(id),
		...object,
	};
	this.clients.set(id,client);
	return client;
};
this.saveConfig=()=>{
	// save the config into file;
	fs.writeFileSync(configFile,JSON.stringify(this.config,null,2).split("  ").join("\t"));
}
this.readConf=()=>{
	let fileData="";
	try{fileData=jsonParseTry(fs.readFileSync(configFile,"utf8"));}
	catch(e){fileData=false;}

	if(!fileData||typeof(fileData)!="object"){
		log("ERROR: config '"+configFile+"' cant read");
		throw new Error("config not exist!");
	}

	return fileData;
}
this.createTemplate=(target,data)=>{
	if(target==="track"){
		return {
			...TEMPLATES.track,
			id: data.id,
			imgs: data.album.images,
			length: data.duration_ms,
			mp3: data.preview_url,
			name: data.name,
			url: data.external_urls.spotify,
		}
	}
	else if(target==="playlist"){
		let items=[];
		let result={};
		if(
			this.playlists.has(data.id)&&
			!data.name
		){
			console.log("load playlist");
			result=this.playlists.get(data.id);
			items=result.items;
		}
		else{
			console.log("create playlist");
			items=new Array(data.tracks.total);
		}
		//console.log(data.tracks.items)
		for(let index=0; index<data.tracks.items.length; index+=1){
			const offset=data.tracks.offset;
			const item=data.tracks.items[index];
			const trackId=item.track.id;
			if(offset) console.log(item)
			if(!this.tracks.has(trackId)){
				log("Add-Track: "+item.track.name);
				this.tracks.set(trackId,this.createTemplate("track",item.track));
				//this.io.emit("set-track",item.track);
			}
			items[index+offset]={
				addedAt: Number(new Date(item.added_at)),
				addedBy: item.added_by.id,
				id: trackId,
			};
		}
		result={
			...TEMPLATES.playlist,
			description: data.description,
			id: data.id,
			imgs: data.images,
			items,
			name: data.name,
			ownerId: data.owner.id,
			ownerName: data.owner.display_name,
			ownerUrl: data.owner.external_urls.spotify,
			public: data.public,
			total: data.tracks.total,
			url: data.external_urls.spotify,
		};
		tmpSAV(result);
		return result;
	}
	else if(target==="device"){
		return {
			...TEMPLATES.device,
			active: data.is_active,
			id: data.id,
			name: data.name,
			type: data.type,
			volume: data.volume_percent,
			volumeSupport: data.supports_volume,
		}
	}
}
this.HandleServerResponse=data=>{
	const {
		args,
		clientRequest,
		serverResponse,
	}=data;
	if(serverResponse.error){
		const status=serverResponse.error.status;
		log("err");
		if(status==401){
			this.refresh_access_token();
		}
		else if(status==503){
			this.callApi(args);
		}
		else{
			console.log(args,serverResponse);
		}
	}

	if(clientRequest==="log-data"){
		console.log("LOG-DATA",serverResponse);
	}
	else if(clientRequest==="get track"){
		if(serverResponse.error){
			this.infos=null;
			this.infos_raw=null;
			if(!this.info_last.noPlayback) this.io.emit("set-infos",null);
			this.info_last.noPlayback=true;
			return false;
		}
		if(!serverResponse){
			this.infos=null;
			this.infos_raw=null;
			log("no server response!");
			if(!this.info_last.noPlayback) this.io.emit("set-infos",null);
			this.info_last.noPlayback=true;
			return false;
		}
		let i={};
		let infos_raw;
		fs.writeFileSync("/tmp/spotifyLastTrackRaw.json",JSON.stringify(serverResponse,null,"\t"));
		try{
			i={
				playing: serverResponse.is_playing,
				repeat: serverResponse.repeat_state,
				shuffle: serverResponse.shuffle_state?(serverResponse.smart_shuffle?"smart-shuffle":"normal-shuffle"):"off",
				progress: serverResponse.progress_ms,
				source:serverResponse.context?{
					type: serverResponse.context.type,
					url: serverResponse.context.external_urls.spotify,
					id: serverResponse.context.uri.split(":")[2],
					//api: serverResponse.context.href,
				}:{
					type: "single-song",
					id: null,
				},
				device: this.createTemplate("device",serverResponse.device),
				track: this.createTemplate("track",serverResponse.item),
				
			};
			infos_raw=serverResponse;
		}catch(e){
			i=null;
			infos_raw=null;
			log("cant load data");
			console.log(e);
		}
		this.infos=i;
		this.infos_raw=infos_raw;

		// tell sockets changes
		if(i.device.id!==this.info_last.deviceId) this.io.emit("change-device",i.device);
		if(i.device.volume!==this.info_last.volume) this.io.emit("change-volume",i.device.volume);
		if(i.playing!==this.info_last.playing) this.io.emit("change-playing",i.playing);
		if(i.progress!==this.info_last.progress) this.io.volatile.emit("change-progress",i.progress);
		if(i.track.id!==this.info_last.trackId) this.io.emit("change-track",i.track);
		if(i.source.id!==this.info_last.sourceId) this.io.emit("change-source",i.source);
		if(Boolean(i)===this.info_last.noPlayback) this.io.emit("set-infos",i);

		if(i.source.type==="playlist"&&!this.playlists.has(i.source.id)){
			this.callApi({
				method: "get",
				url: URLS.playlist+"/"+i.source.id,
				request: "get playlist",
			});
		}

		this.info_last={
			...this.info_last,
			deviceId: i.device.id,
			playing: i.playing,
			progress: i.progress,
			sourceId: i.source.id,
			trackId: i.track.id,
			volume: i.device.volume,
			noPlayback: !Boolean(i),
		};
	}
	else if(clientRequest==="get playlist"){
		//console.log(serverResponse);
		try{
			if(this.playlists.has(serverResponse.id)){
				log("get-playlist already exists!");
				return false;
			}
			const playlist={
				...TEMPLATES.playlist,
				description: serverResponse.description,
				id: serverResponse.id,
				imgs: serverResponse.images,
				items: new Array(serverResponse.tracks.total),
				name: serverResponse.name,
				ownerId: serverResponse.owner.id,
				ownerName: serverResponse.owner.display_name,
				ownerUrl: serverResponse.owner.external_urls.spotify,
				public: serverResponse.public,
				total: serverResponse.tracks.total,
				url: serverResponse.external_urls.spotify,
			}
			for(let index=0; index<serverResponse.tracks.items.length; index+=1){
				const offset=serverResponse.tracks.offset;
				const item=serverResponse.tracks.items[index];
				const trackId=item.track.id;
				if(offset) console.log(item)
				if(!this.tracks.has(trackId)){
					log("Add-Track: "+item.track.name);
					this.tracks.set(trackId,this.createTemplate("track",item.track));
					//this.io.emit("set-track",item.track);
				}
				playlist.items[index+offset]={
					addedAt: Number(new Date(item.added_at)),
					addedBy: item.added_by.id,
					id: trackId,
				};
			}
			console.log("new list "+playlist.id);
			this.playlists.set(playlist.id,playlist);
			


			if(serverResponse.tracks.next){
				log("Loading more Playlist items for "+playlist.name+" "+serverResponse.tracks.next);
				this.callApi({
					method: "get",
					playlistId: serverResponse.id,
					request: "get playlist-tracks",
					url: serverResponse.tracks.next,
				});
			}else{
				log("Add-Playlist: "+playlist.name);
				this.io.emit("set-playlist",playlist);
			}
		}catch(e){console.log("err:",e);}
	
		fs.writeFileSync("/tmp/spotifyLastPlaylist.json",JSON.stringify(serverResponse,null,"\t"));
	}
	else if(clientRequest==="get playlist-tracks"){
		fs.writeFileSync("/tmp/spotifyLastPlaylistExtend.json",JSON.stringify(serverResponse,null,"\t"));
		if(!args.playlistId){
			log("request get playlist-tracks but no playlistId given!");
			return false;
		}
		if(!this.playlists.has(args.playlistId)){
			log("request get-playlist-tracks playlist not exist with id: "+args.playlistId);
		}
		let playlist=this.playlists.get(args.playlistId);
	}
	else if(clientRequest==="get access_token"){
		this.config.access_token=serverResponse.access_token;
		this.saveConfig();
	}
}
this.callApi=data=>{
	const {
		auth="token",
		body,
		contentType="application/json",
		method="get",
		request,
		url,
	}=data;
	log("request: "+request);
	fetch(url,{
		method: method.toUpperCase(),
		headers: {
			"Content-Type": contentType,
			"Authorization":(
				auth==="token"
				?	"Bearer "+this.config.access_token
				:	"Basic "+encodeBase64(this.config.client_id+":"+this.config.client_secret)
			),
		},
		body: typeof(body)=="string"?body: JSON.stringify(body),
	})
		.then(res=>res.text())
		.then(res=>this.HandleServerResponse({
			args: data,
			clientRequest: request,
			serverResponse: jsonParseTry(res),
		}))
		.catch(res=>{
			this.infos=null;
			this.infos_raw=null;
			//log("cant call api");
		});
}
this.refresh_access_token=()=>{
	let body="grant_type=refresh_token";
	body+="&refresh_token="+this.config.refresh_token;
	body+="&client_id="+this.config.client_id;
	this.callApi({
		auth: "client_secret",
		body,
		contentType: "application/x-www-form-urlencoded",
		method: "post",
		request: "get access_token",
		url: URLS.token,
	});
}
this.playbackAction=(data)=>{
	const {action}=data;

	if(action==="next"){
		this.callApi({
			method: "post",
			url: URLS.next,
		});
	}
	else if(action==="previous"){
		this.callApi({
			method: "post",
			url: URLS.previous,
		});
	}
	else if(action==="pause"){
		this.callApi({
			method: "put",
			url: URLS.pause,
		});
	}
	else if(action==="play"){
		const {
			deviceId,
			context,
			offset,
		}=data;
		let url=URLS.play+"?device_id="+(deviceId?deviceId:this.info_last.deviceId);
		const body={};
		if(context) body.context_uri=context;
		if(offset) body.offset={position:Number(offset)},
		console.log(body);
		this.callApi({
			method: "put",
			url,
			body,
		});
	}
}

this.stop=()=>{
	this.saveConfig();
	this.infos=null;
	this.infos_raw=null;
	this.io.close(err=>{
		if(err) log("Cant stop Socket Server!");
	});
}
