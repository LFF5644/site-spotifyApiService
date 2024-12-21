const socketIo=require("socket.io");
const socketIoClient=require("socket.io-client");
const alsamixer=require("alsamixer")({
	card: 0,
	defaultItem: "PCM",
	spawnCommandListener: true,
});

const services={
	account: service_require("server/account/account.new"),
};

const musikPlayerServer="http://127.0.0.1:4561";

this.start=()=>{
	this.currentlyPlaying=null;
	this.tracks=[];
	this.clients=new Map();
	this.alsamixer={
		volume: 50,
	};

	this.io=new socketIo.Server(27397,{cors:{origin:"*"}});
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
				rankAttr: "musikPlayer-changePlayback",
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
			currentlyPlaying: this.currentlyPlaying,
			tracks: this.tracks,
			volume: this.alsamixer.volume,
		});
		if(client.allowChangePlayback){
			socket.on("action-playback",(action,callback=()=>{})=>{
				this.musikPlayerClient.emit("action-playback",action,result=>{
					callback(result);
				});
			});
			socket.on("set-playback",(data,callback=()=>{})=>{
				this.musikPlayerClient.emit("set-playback",data,result=>{
					callback(result);
				});
			});
			socket.on("set-volume",volume=>{
				alsamixer.setVolume(volume);
			});
		}
	});

	alsamixer.on("volumeChange",(_eventName,data)=>{
		if(this.alsamixer.volume!==data.volume){
			this.io.emit("change-volume",data.volume);
		}
		this.alsamixer=data;
	});
	alsamixer.getVolume();

	this.musikPlayerClient=socketIoClient.io(musikPlayerServer);
	this.musikPlayerClient.on("connect_error",error=>{
		this.currentlyPlaying=null;
		//console.log("connect error",error.context.statusText.code);
		if(error.context.statusText.code==="ECONNREFUSED"){}
		else{
			throw error;
		}
		setTimeout(()=> this.musikPlayerClient.connect(),1e3);
	});
	this.musikPlayerClient.on("currentlyPlaying",currentlyPlaying=>{
		this.currentlyPlaying=currentlyPlaying;
		this.io.emit("currentlyPlaying",currentlyPlaying);
	});
	this.musikPlayerClient.on("set-tracks",tracks=>{
		this.tracks=tracks.map((item,index)=>({
			...item,
			index,
		}));
	});
	this.musikPlayerClient.on("connect",()=>console.log("connected"));
	this.musikPlayerClient.on("disconnect",()=>console.log("disconnected"));
	this.musikPlayerClient.emit("get-tracks");
	
};
this.writeClient=(id,object)=>{
	const client={
		...this.clients.get(id),
		...object,
	};
	this.clients.set(id,client);
	return client;
};
this.stop=()=>{
	this.musikPlayerClient.disconnect();
	this.io.close();
	alsamixer.close();
};
