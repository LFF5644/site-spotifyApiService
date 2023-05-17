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

const configFile="data/spotifyLoginData.json";
const URLS={
	"authorize":	"https://accounts.spotify.com/authorize",
	"devices":		"https://api.spotify.com/v1/me/player/devices",
	"next":			"https://api.spotify.com/v1/me/player/next",
	"nowPlaying": 	"https://api.spotify.com/v1/me/player/currently-playing",
	"pause": 		"https://api.spotify.com/v1/me/player/pause",
	"play":			"https://api.spotify.com/v1/me/player/play",
	"player":		"https://api.spotify.com/v1/me/player",
	"playlists": 	"https://api.spotify.com/v1/me/playlists",
	"previous":		"https://api.spotify.com/v1/me/player/previous",
	"shuffle":		"https://api.spotify.com/v1/me/player/shuffle",
	"token":		"https://accounts.spotify.com/api/token",
	"tracks":		"https://api.spotify.com/v1/playlists/[playListId]/tracks",
	"volume":		"https://api.spotify.com/v1/me/player/volume",
};

this.start=()=>{
	this.clients=new Map();
	this.config=this.readConf();
	this.infos_raw=null;
	this.infos=null;
	this.info_last={
		deviceId: null,
		playing: null,
		progress: null,
		trackId: null,
		lastSend: 0,
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
		socket.on("disconnect",()=>{
			this.clients.delete(id);
		});

		if(client.allowChangePlayback) socket.on("playbackAction",action=>{
			this.playbackAction(action);
		});
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
	setInterval(()=>{
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
			now-this.info_last.lastSend>2e3&&
			this.clients.size>0
		) call();
		else if(
			now-this.info_last.lastSend>10e3&&
			this.clients.size<1
		) call();

	},1e3);
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
this.HandleServerResponse=data=>{
	const {
		args,
		clientRequest,
		serverResponse,
	}=data;
	if(serverResponse.error){
		const status=serverResponse.error.status;
		if(status==401){
			this.refresh_access_token();
		}
		else if(status==503){
			this.callApi(args);
		}
	}
	if(clientRequest=="get track"){
		if(serverResponse.error){
			this.infos=null;
			return false;
		}
		let i={};
		let infos_raw;
		try{
			i={
				playing: serverResponse.is_playing,
				device:{
					active: serverResponse.device.is_active,
					id: serverResponse.device.id,
					name: serverResponse.device.name,
					type: serverResponse.device.type,
					volume: serverResponse.device.volume_percent,
				},
				track:{
					id: serverResponse.item.id,
					imgs: serverResponse.item.album.images,
					length: serverResponse.item.duration_ms,
					mp3: serverResponse.item.preview_url,
					name: serverResponse.item.name,
					progress: serverResponse.progress_ms,
					url: serverResponse.item.external_urls.spotify,
				},
			};
			infos_raw=serverResponse;
		}catch(e){
			i=null;
			infos_raw=null;
			//log("cant load data");
		}
		this.infos=i;
		this.infos_raw=infos_raw;

		// tell sockets changes
		if(i.device.id!==this.info_last.deviceId) this.io.emit("change-device",i.device);
		if(i.playing!==this.info_last.playing) this.io.emit("change-playing",i.playing);
		if(i.track.progress!==this.info_last.progress) this.io.emit("change-progress",i.track.progress);
		if(i.track.id!==this.info_last.trackId) this.io.emit("change-track",i.track);

		this.info_last={
			...this.info_last,
			deviceId: i.device.id,
			playing: i.playing,
			progress: i.track.progress,
			trackId: i.track.id,
		};
	}
	if(clientRequest=="get access_token"){
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
	console.log(data);
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
		const {deviceId}=data;
		const url=URLS.play+"?device_id="+(deviceId?deviceId:this.info_last.deviceId);
		log(url);
		this.callApi({
			method: "put",
			url,
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
